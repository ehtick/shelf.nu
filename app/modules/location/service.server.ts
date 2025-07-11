import type {
  Prisma,
  User,
  Location,
  Organization,
  UserOrganization,
} from "@prisma/client";
import invariant from "tiny-invariant";
import { db } from "~/database/db.server";
import { getSupabaseAdmin } from "~/integrations/supabase/client";
import { PUBLIC_BUCKET } from "~/utils/constants";
import type { ErrorLabel } from "~/utils/error";
import {
  ShelfError,
  isLikeShelfError,
  isNotFoundError,
  maybeUniqueConstraintViolation,
} from "~/utils/error";
import { getRedirectUrlFromRequest } from "~/utils/http";
import { id } from "~/utils/id/id.server";
import { ALL_SELECTED_KEY } from "~/utils/list";
import {
  getFileUploadPath,
  parseFileFormData,
  removePublicFile,
} from "~/utils/storage.server";
import type { CreateAssetFromContentImportPayload } from "../asset/types";

const label: ErrorLabel = "Location";

export async function getLocation(
  params: Pick<Location, "id"> & {
    organizationId: Organization["id"];
    /** Page number. Starts at 1 */
    page?: number;
    /** Assets to be loaded per page with the location */
    perPage?: number;
    search?: string | null;
    orderBy?: string;
    orderDirection?: "asc" | "desc";
    userOrganizations?: Pick<UserOrganization, "organizationId">[];
    request?: Request;
    include?: Prisma.LocationInclude;
  }
) {
  const {
    organizationId,
    id,
    page = 1,
    perPage = 8,
    search,
    userOrganizations,
    request,
    orderBy = "createdAt",
    orderDirection,
    include,
  } = params;

  try {
    const otherOrganizationIds = userOrganizations?.map(
      (org) => org.organizationId
    );

    const skip = page > 1 ? (page - 1) * perPage : 0;
    const take = perPage >= 1 ? perPage : 8; // min 1 and max 25 per page

    /** Build where object for querying related assets */
    let assetsWhere: Prisma.AssetWhereInput = {};

    if (search) {
      assetsWhere.title = {
        contains: search,
        mode: "insensitive",
      };
    }

    const [location, totalAssetsWithinLocation] = await Promise.all([
      /** Get the items */
      db.location.findFirstOrThrow({
        where: {
          OR: [
            { id, organizationId },
            ...(userOrganizations?.length
              ? [{ id, organizationId: { in: otherOrganizationIds } }]
              : []),
          ],
        },
        include: include
          ? include
          : {
              assets: {
                include: {
                  category: {
                    select: {
                      id: true,
                      name: true,
                      color: true,
                    },
                  },
                  tags: {
                    select: {
                      id: true,
                      name: true,
                    },
                  },
                },
                skip,
                take,
                where: assetsWhere,
                orderBy: { [orderBy]: orderDirection },
              },
            },
      }),

      /** Count them */
      db.asset.count({
        where: {
          locationId: id,
        },
      }),
    ]);

    /* User is accessing the asset in the wrong organization. In that case we need special 404 handling. */
    if (
      userOrganizations?.length &&
      location.organizationId !== organizationId &&
      otherOrganizationIds?.includes(location.organizationId)
    ) {
      const redirectTo =
        typeof request !== "undefined"
          ? getRedirectUrlFromRequest(request)
          : undefined;

      throw new ShelfError({
        cause: null,
        title: "Location not found.",
        message: "",
        additionalData: {
          model: "location",
          organization: userOrganizations.find(
            (org) => org.organizationId === location.organizationId
          ),
          redirectTo,
        },
        label,
        status: 404,
        shouldBeCaptured: false,
      });
    }

    return { location, totalAssetsWithinLocation };
  } catch (cause) {
    const isShelfError = isLikeShelfError(cause);

    throw new ShelfError({
      cause,
      title: "Location not found",
      message:
        "The location you are trying to access does not exist or you do not have permission to access it.",
      additionalData: {
        id,
        organizationId,
        ...(isLikeShelfError(cause) ? cause.additionalData : {}),
      },
      label,
      shouldBeCaptured: isShelfError
        ? cause.shouldBeCaptured
        : !isNotFoundError(cause),
    });
  }
}

export async function getLocations(params: {
  organizationId: Organization["id"];
  /** Page number. Starts at 1 */
  page?: number;
  /** Items to be loaded per page */
  perPage?: number;
  search?: string | null;
}) {
  const { organizationId, page = 1, perPage = 8, search } = params;

  try {
    const skip = page > 1 ? (page - 1) * perPage : 0;
    const take = perPage >= 1 ? perPage : 8; // min 1 and max 25 per page

    /** Default value of where. Takes the items belonging to current user */
    let where: Prisma.LocationWhereInput = { organizationId };

    /** If the search string exists, add it to the where object */
    if (search) {
      where.name = {
        contains: search,
        mode: "insensitive",
      };
    }

    const [locations, totalLocations] = await Promise.all([
      /** Get the items */
      db.location.findMany({
        skip,
        take,
        where,
        orderBy: { updatedAt: "desc" },
        include: {
          assets: true,
          image: {
            select: {
              updatedAt: true,
            },
          },
        },
      }),

      /** Count them */
      db.location.count({ where }),
    ]);

    return { locations, totalLocations };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while fetching the locations",
      additionalData: { ...params },
      label,
    });
  }
}

export async function createLocation({
  name,
  description,
  address,
  userId,
  organizationId,
}: Pick<Location, "description" | "name" | "address"> & {
  userId: User["id"];
  organizationId: Organization["id"];
}) {
  try {
    return await db.location.create({
      data: {
        name,
        description,
        address,
        user: {
          connect: {
            id: userId,
          },
        },
        organization: {
          connect: {
            id: organizationId,
          },
        },
      },
    });
  } catch (cause) {
    throw maybeUniqueConstraintViolation(cause, "Location", {
      additionalData: { userId, organizationId },
    });
  }
}

export async function deleteLocation({
  id,
  organizationId,
}: Pick<Location, "id" | "organizationId">) {
  try {
    const location = await db.location.delete({
      where: { id, organizationId },
    });

    if (location.imageId) {
      await db.image.delete({
        where: { id: location.imageId },
      });
    }

    return location;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while deleting the location",
      additionalData: { id },
      label,
    });
  }
}

export async function updateLocation(payload: {
  id: Location["id"];
  name?: Location["name"];
  address?: Location["address"];
  description?: Location["description"];
  userId: User["id"];
  organizationId: Organization["id"];
}) {
  const { id, name, address, description, userId, organizationId } = payload;

  try {
    return await db.location.update({
      where: { id, organizationId },
      data: {
        name,
        description,
        address,
      },
    });
  } catch (cause) {
    throw maybeUniqueConstraintViolation(cause, "Location", {
      additionalData: {
        id,
        userId,
        organizationId,
      },
    });
  }
}

export async function createLocationsIfNotExists({
  data,
  userId,
  organizationId,
}: {
  data: CreateAssetFromContentImportPayload[];
  userId: User["id"];
  organizationId: Organization["id"];
}): Promise<Record<string, Location["id"]>> {
  try {
    // first we get all the locations from the assets and make then into an object where the category is the key and the value is an empty string
    const locations = new Map(
      data
        .filter((asset) => asset.location !== "")
        .map((asset) => [asset.location, ""])
    );

    // Handle the case where there are no teamMembers
    if (locations.has(undefined)) {
      return {};
    }

    // now we loop through the locations and check if they exist
    for (const [location, _] of locations) {
      const existingLocation = await db.location.findFirst({
        where: {
          name: { equals: location, mode: "insensitive" },
          organizationId,
        },
      });

      if (!existingLocation) {
        // if the location doesn't exist, we create a new one
        const newLocation = await db.location.create({
          data: {
            name: (location as string).trim(),
            user: {
              connect: {
                id: userId,
              },
            },
            organization: {
              connect: {
                id: organizationId,
              },
            },
          },
        });
        locations.set(location, newLocation.id);
      } else {
        // if the location exists, we just update the id
        locations.set(location, existingLocation.id);
      }
    }

    return Object.fromEntries(Array.from(locations));
  } catch (cause) {
    throw new ShelfError({
      cause,
      message:
        "Something went wrong while creating locations. Seems like some of the location data in your import file is invalid. Please check and try again.",
      additionalData: { userId, organizationId },
      label,
      /** No need to capture those. They are mostly related to malformed CSV data */
      shouldBeCaptured: false,
    });
  }
}

export async function bulkDeleteLocations({
  locationIds,
  organizationId,
}: {
  locationIds: Location["id"][];
  organizationId: Organization["id"];
}) {
  try {
    /** We have to delete the images of locations if any */
    const locations = await db.location.findMany({
      where: locationIds.includes(ALL_SELECTED_KEY)
        ? { organizationId }
        : { id: { in: locationIds }, organizationId },
      select: { id: true, imageId: true },
    });

    return await db.$transaction(async (tx) => {
      /** Deleting all locations */
      await tx.location.deleteMany({
        where: { id: { in: locations.map((location) => location.id) } },
      });

      /** Deleting images of locations */
      const locationWithImages = locations.filter(
        (location) => !!location.imageId
      );
      await tx.image.deleteMany({
        where: {
          id: {
            in: locationWithImages.map((location) => {
              invariant(location.imageId, "Image not found to delete");
              return location.imageId;
            }),
          },
        },
      });
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while bulk deleting locations.",
      additionalData: { locationIds, organizationId },
      label,
    });
  }
}

export async function updateLocationImage({
  organizationId,
  request,
  locationId,
  prevImageUrl,
  prevThumbnailUrl,
}: {
  organizationId: Organization["id"];
  request: Request;
  locationId: Location["id"];
  prevImageUrl?: string | null;
  prevThumbnailUrl?: string | null;
}) {
  try {
    const fileData = await parseFileFormData({
      request,
      bucketName: PUBLIC_BUCKET,
      newFileName: getFileUploadPath({
        organizationId,
        type: "locations",
        typeId: locationId,
      }),
      resizeOptions: {
        width: 1200,
        withoutEnlargement: true,
      },
      generateThumbnail: true,
      thumbnailSize: 108,
    });

    const image = fileData.get("image") as string | null;
    if (!image) {
      return;
    }

    let imagePath: string;
    let thumbnailPath: string | null = null;

    try {
      const parsedImage = JSON.parse(image);
      if (parsedImage.originalPath) {
        imagePath = parsedImage.originalPath;
        thumbnailPath = parsedImage.thumbnailPath;
      } else {
        imagePath = image;
      }
    } catch (error) {
      imagePath = image;
    }

    const {
      data: { publicUrl: imagePublicUrl },
    } = getSupabaseAdmin().storage.from(PUBLIC_BUCKET).getPublicUrl(imagePath);

    let thumbnailPublicUrl: string | undefined;
    if (thumbnailPath) {
      const {
        data: { publicUrl },
      } = getSupabaseAdmin()
        .storage.from(PUBLIC_BUCKET)
        .getPublicUrl(thumbnailPath);
      thumbnailPublicUrl = publicUrl;
    }

    await db.location.update({
      where: { id: locationId, organizationId },
      data: {
        imageUrl: imagePublicUrl,
        thumbnailUrl: thumbnailPublicUrl ? thumbnailPublicUrl : undefined,
      },
    });

    if (prevImageUrl) {
      await removePublicFile({ publicUrl: prevImageUrl });
    }

    if (prevThumbnailUrl) {
      await removePublicFile({ publicUrl: prevThumbnailUrl });
    }
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: isLikeShelfError(cause)
        ? cause.message
        : "Something went wrong while updating the location image.",
      additionalData: { locationId },
      label,
    });
  }
}

export async function generateLocationWithImages({
  organizationId,
  numberOfLocations,
  image,
  userId,
}: {
  userId: User["id"];
  organizationId: Organization["id"];
  numberOfLocations: number;
  image: File;
}) {
  try {
    for (let i = 1; i <= numberOfLocations; i++) {
      const imageCreated = await db.image.create({
        data: {
          blob: Buffer.from(await image.arrayBuffer()),
          contentType: image.type,
          ownerOrg: { connect: { id: organizationId } },
          user: { connect: { id: userId } },
        },
      });

      await db.location.create({
        data: {
          /**
           * We are using id() for names because location names are unique.
           * This location is going to be created for testing purposes only so the name in this case
           * doesn't matter.
           */
          name: id(),
          /**
           * This approach is @deprecated and will not be used in the future.
           * Instead, we will store images in supabase storage and use the public URL.
           */
          image: { connect: { id: imageCreated.id } },
          user: {
            connect: {
              id: userId,
            },
          },
          organization: {
            connect: {
              id: organizationId,
            },
          },
        },
      });
    }
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: isLikeShelfError(cause)
        ? cause.message
        : "Something went wrong while generating locations.",
      additionalData: { organizationId, numberOfLocations },
      label,
    });
  }
}
