import type {
  ActionFunctionArgs,
  LinksFunction,
  LoaderFunctionArgs,
  MetaFunction,
} from "@remix-run/node";
import { redirect, json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";

import mapCss from "maplibre-gl/dist/maplibre-gl.css?url";
import { useZorm } from "react-zorm";
import { z } from "zod";
import ActionsDropdown from "~/components/assets/actions-dropdown";
import { AssetImage } from "~/components/assets/asset-image";
import { AssetStatusBadge } from "~/components/assets/asset-status-badge";
import { Notes } from "~/components/assets/notes";
import { Switch } from "~/components/forms/switch";
import ContextualModal from "~/components/layout/contextual-modal";
import ContextualSidebar from "~/components/layout/contextual-sidebar";

import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { ScanDetails } from "~/components/location/scan-details";

import { Badge } from "~/components/shared/badge";
import { Button } from "~/components/shared/button";
import { Card } from "~/components/shared/card";
import { Tag } from "~/components/shared/tag";
import TextualDivider from "~/components/shared/textual-divider";
import { usePosition } from "~/hooks/use-position";
import { useUserIsSelfService } from "~/hooks/user-user-is-self-service";
import {
  deleteAsset,
  getAsset,
  updateAssetBookingAvailability,
} from "~/modules/asset/service.server";
import type { ShelfAssetCustomFieldValueType } from "~/modules/asset/types";
import { getScanByQrId } from "~/modules/scan/service.server";
import { parseScanData } from "~/modules/scan/utils.server";
import assetCss from "~/styles/asset.css?url";

import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { checkExhaustiveSwitch } from "~/utils/check-exhaustive-switch";
import { getDateTimeFormat, getLocale } from "~/utils/client-hints";
import { getCustomFieldDisplayValue } from "~/utils/custom-fields";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError } from "~/utils/error";
import { isFormProcessing } from "~/utils/form";
import { error, getParams, data, parseData } from "~/utils/http.server";
import { parseMarkdownToReact } from "~/utils/md.server";
import { isLink } from "~/utils/misc";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.validator.server";
import { requirePermission } from "~/utils/roles.server";
import { deleteAssetImage } from "~/utils/storage.server";
import { tw } from "~/utils/tw";

export const AvailabilityForBookingFormSchema = z.object({
  availableToBook: z
    .string()
    .transform((val) => val === "on")
    .default("false"),
});

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { assetId: id } = getParams(params, z.object({ assetId: z.string() }), {
    additionalData: { userId },
  });

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.asset,
      action: PermissionAction.read,
    });

    const locale = getLocale(request);

    const asset = await getAsset({ organizationId, id });

    /** We get the first QR code(for now we can only have 1)
     * And using the ID of tha qr code, we find the latest scan
     */
    const lastScan = asset.qrCodes[0]?.id
      ? parseScanData({
          scan: (await getScanByQrId({ qrId: asset.qrCodes[0].id })) || null,
          userId,
          request,
        })
      : null;

    const notes = asset.notes.map((note) => ({
      ...note,
      dateDisplay: getDateTimeFormat(request, {
        dateStyle: "short",
        timeStyle: "short",
      }).format(note.createdAt),
      content: parseMarkdownToReact(note.content),
    }));

    let custody = null;
    if (asset.custody) {
      const date = new Date(asset.custody.createdAt);
      const dateDisplay = getDateTimeFormat(request, {
        dateStyle: "short",
        timeStyle: "short",
      }).format(date);

      custody = {
        ...asset.custody,
        dateDisplay,
      };
    }

    const header: HeaderData = {
      title: asset.title,
    };

    return json(
      data({
        asset: {
          ...asset,
          custody,
          notes,
        },
        lastScan,
        header,
        locale,
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause);
    throw json(error(reason));
  }
}

export async function action({ context, request, params }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { assetId: id } = getParams(params, z.object({ assetId: z.string() }), {
    additionalData: { userId },
  });

  try {
    const formData = await request.formData();

    const { intent } = parseData(
      formData,
      z.object({ intent: z.enum(["delete", "toggle"]) })
    );

    const intent2ActionMap: { [K in typeof intent]: PermissionAction } = {
      delete: PermissionAction.delete,
      toggle: PermissionAction.update,
    };

    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.asset,
      action: intent2ActionMap[intent],
    });

    switch (intent) {
      case "delete": {
        const { mainImageUrl } = parseData(
          formData,
          z.object({ mainImageUrl: z.string().optional() })
        );

        await deleteAsset({ organizationId, id });

        if (mainImageUrl) {
          await deleteAssetImage({
            url: mainImageUrl,
            bucketName: "assets",
          });
        }

        sendNotification({
          title: "Asset deleted",
          message: "Your asset has been deleted successfully",
          icon: { name: "trash", variant: "error" },
          senderId: authSession.userId,
        });

        return redirect(`/assets`);
      }
      case "toggle": {
        const { availableToBook } = parseData(
          formData,
          AvailabilityForBookingFormSchema
        );

        await updateAssetBookingAvailability(id, availableToBook);

        sendNotification({
          title: "Asset availability status updated successfully",
          message: "Your asset's availability for booking has been updated",
          icon: { name: "success", variant: "success" },
          senderId: authSession.userId,
        });

        return json(data(null));
      }
      default: {
        checkExhaustiveSwitch(intent);
        return json(data(null));
      }
    }
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, id });
    return json(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: appendToMetaTitle(data?.header?.title) },
];

export const handle = {
  breadcrumb: () => "single",
};

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: assetCss },
  { rel: "stylesheet", href: mapCss },
];

export default function AssetDetailsPage() {
  const { asset, locale } = useLoaderData<typeof loader>();
  const customFieldsValues =
    asset.customFields?.length > 0
      ? asset.customFields.filter((f) => f.value)
      : [];
  const assetIsAvailable = asset.status === "AVAILABLE";
  /** Due to some conflict of types between prisma and remix, we need to use the SerializeFrom type
   * Source: https://github.com/prisma/prisma/discussions/14371
   */
  const location = asset.location;
  usePosition();
  const fetcher = useFetcher();
  const zo = useZorm(
    "NewQuestionWizardScreen",
    AvailabilityForBookingFormSchema
  );
  const isSelfService = useUserIsSelfService();

  return (
    <>
      <Header
        subHeading={
          <div className="flex gap-2">
            <AssetStatusBadge
              status={asset.status}
              availableToBook={asset.availableToBook}
            />
            {location ? (
              <span className="inline-flex justify-center rounded-2xl bg-gray-100 px-[8px] py-[2px] text-center text-[12px] font-medium text-gray-700">
                {location.name}
              </span>
            ) : null}
          </div>
        }
      >
        {!isSelfService ? (
          <>
            <Button to="qr" variant="secondary" icon="barcode">
              View QR code
            </Button>
            <ActionsDropdown />
          </>
        ) : null}
      </Header>

      <ContextualModal />
      <div className="mt-8 block lg:flex">
        <div className="shrink-0 overflow-hidden lg:w-[343px] xl:w-[400px]">
          <AssetImage
            asset={{
              assetId: asset.id,
              mainImage: asset.mainImage,
              mainImageExpiration: asset.mainImageExpiration,
              alt: asset.title,
            }}
            className={tw(
              " h-auto w-full rounded border object-cover",
              asset.description ? "rounded-b-none border-b-0" : ""
            )}
          />
          {asset.description ? (
            <Card className="mb-3 mt-0 rounded-t-none border-t-0">
              <p className="whitespace-pre-wrap text-gray-600">{asset.description}</p>
            </Card>
          ) : null}
          {!isSelfService ? (
            <Card className="my-3">
              <fetcher.Form
                ref={zo.ref}
                method="post"
                onChange={(e) => fetcher.submit(e.currentTarget)}
              >
                <div className="flex justify-between gap-3">
                  <div>
                    <p className="text-[14px] font-medium text-gray-700">
                      Available for bookings
                    </p>
                    <p className="text-[12px] text-gray-600">
                      Asset is available for being used in bookings
                    </p>
                  </div>
                  <Switch
                    name={zo.fields.availableToBook()}
                    disabled={isSelfService || isFormProcessing(fetcher.state)} // Disable for self service users
                    defaultChecked={asset.availableToBook}
                    required
                    title={
                      isSelfService
                        ? "You do not have the permissions to change availability"
                        : "Toggle availability"
                    }
                  />
                  <input type="hidden" value="toggle" name="intent" />
                </div>
              </fetcher.Form>
            </Card>
          ) : null}

          {/* We simply check if the asset is available and we can assume that if it't not, there is a custodian assigned */}
          {!isSelfService && !assetIsAvailable && asset?.custody?.createdAt ? (
            <Card className="my-3">
              <div className="flex items-center gap-3">
                <img
                  src="/static/images/default_pfp.jpg"
                  alt="custodian"
                  className="size-10 rounded"
                />
                <div>
                  <p className="">
                    In custody of{" "}
                    <span className="font-semibold">
                      {asset.custody?.custodian.name}
                    </span>
                  </p>
                  <span>Since {asset.custody.dateDisplay}</span>
                </div>
              </div>
            </Card>
          ) : null}

          <TextualDivider text="Details" className="mb-8 lg:hidden" />
          <Card className="my-3">
            <ul className="item-information">
              <li className="mb-4 flex justify-between">
                <span className="text-[12px] font-medium text-gray-600">
                  ID
                </span>
                <div className="max-w-[250px]">{asset.id}</div>
              </li>
              {asset?.category ? (
                <li className="mb-4 flex justify-between">
                  <span className="text-[12px] font-medium text-gray-600">
                    Category
                  </span>
                  <div className="max-w-[250px]">
                    <Badge color={asset.category?.color} withDot={false}>
                      {asset.category?.name}
                    </Badge>
                  </div>
                </li>
              ) : (
                <li className="mb-4 flex justify-between">
                  <span className="text-[12px] font-medium text-gray-600">
                    Category
                  </span>
                  <div className="max-w-[250px]">
                    <Badge color={"#808080"} withDot={false}>
                      Uncategorized
                    </Badge>
                  </div>
                </li>
              )}
              {location ? (
                <li className="mb-2 flex justify-between">
                  <span className="text-[12px] font-medium text-gray-600">
                    Location
                  </span>
                  <div className="max-w-[250px]">
                    <Tag key={location.id} className="mb-2 ml-2">
                      {location.name}
                    </Tag>
                  </div>
                </li>
              ) : null}
              {asset?.tags?.length > 0 ? (
                <li className="mb-2 flex justify-between">
                  <span className="text-[12px] font-medium text-gray-600">
                    Tags
                  </span>
                  <div className="text-right ">
                    {asset.tags.map((tag) => (
                      <Tag key={tag.id} className="mb-2 ml-2">
                        {tag.name}
                      </Tag>
                    ))}
                  </div>
                </li>
              ) : null}
              {asset.organization && asset.valuation ? (
                <li className="flex justify-between">
                  <span className="text-[12px] font-medium text-gray-600">
                    Value
                  </span>
                  <div className="max-w-[250px]">
                    <Tag key={asset.valuation} className="mb-2 ml-2">
                      <>
                        {asset.valuation.toLocaleString(locale, {
                          style: "currency",
                          currency: asset.organization.currency,
                        })}
                      </>
                    </Tag>
                  </div>
                </li>
              ) : null}
            </ul>
          </Card>

          {/* Here custom fields relates to AssetCustomFieldValue */}
          {customFieldsValues?.length > 0 ? (
            <>
              <TextualDivider
                text="Custom fields"
                className="mb-8 pt-3 lg:hidden"
              />
              <Card className="my-3">
                <ul className="item-information">
                  {customFieldsValues.map((field, index) => {
                    const customFieldDisplayValue = getCustomFieldDisplayValue(
                      field.value as unknown as ShelfAssetCustomFieldValueType["value"]
                    );
                    return (
                      <li
                        className={tw(
                          "flex justify-between",
                          index === customFieldsValues.length - 1 ? "" : "mb-4 "
                        )}
                        key={field.id}
                      >
                        <span className="text-[12px] font-medium text-gray-600">
                          {field.customField.name}
                        </span>
                        <div className="max-w-[250px] text-end">
                          {isLink(customFieldDisplayValue) ? (
                            <Button
                              role="link"
                              variant="link"
                              className="text-gray text-end font-normal underline hover:text-gray-600"
                              target="_blank"
                              to={`${customFieldDisplayValue}?ref=shelf-webapp`}
                            >
                              {customFieldDisplayValue}
                            </Button>
                          ) : (
                            customFieldDisplayValue
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </>
          ) : null}
          {!isSelfService ? <ScanDetails /> : null}
        </div>

        <div className="w-full lg:ml-6">
          {isSelfService ? (
            <div className="flex h-full flex-col justify-center">
              <div className="flex flex-col items-center justify-center  text-center">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width={56}
                  height={56}
                  fill="none"
                >
                  <rect
                    width={48}
                    height={48}
                    x={4}
                    y={4}
                    fill="#FDEAD7"
                    rx={24}
                  />
                  <rect
                    width={48}
                    height={48}
                    x={4}
                    y={4}
                    stroke="#FEF6EE"
                    strokeWidth={8}
                    rx={24}
                  />
                  <path
                    stroke="#EF6820"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="m26 31-3.075 3.114c-.43.434-.644.651-.828.667a.5.5 0 0 1-.421-.173c-.12-.14-.12-.446-.12-1.056v-1.56c0-.548-.449-.944-.99-1.024v0a3 3 0 0 1-2.534-2.533C18 28.219 18 27.96 18 27.445V22.8c0-1.68 0-2.52.327-3.162a3 3 0 0 1 1.311-1.311C20.28 18 21.12 18 22.8 18h7.4c1.68 0 2.52 0 3.162.327a3 3 0 0 1 1.311 1.311C35 20.28 35 21.12 35 22.8V27m0 11-2.176-1.513c-.306-.213-.46-.32-.626-.395a2.002 2.002 0 0 0-.462-.145c-.18-.033-.367-.033-.74-.033H29.2c-1.12 0-1.68 0-2.108-.218a2 2 0 0 1-.874-.874C26 34.394 26 33.834 26 32.714V30.2c0-1.12 0-1.68.218-2.108a2 2 0 0 1 .874-.874C27.52 27 28.08 27 29.2 27h5.6c1.12 0 1.68 0 2.108.218a2 2 0 0 1 .874.874C38 28.52 38 29.08 38 30.2v2.714c0 .932 0 1.398-.152 1.766a2 2 0 0 1-1.083 1.082c-.367.152-.833.152-1.765.152V38Z"
                  />
                </svg>
                <h5>Insufficient permissions</h5>
                <p>You are not allowed to view asset notes</p>
              </div>
            </div>
          ) : (
            <>
              <TextualDivider text="Notes" className="mb-8 lg:hidden" />
              <Notes />
            </>
          )}
        </div>
      </div>
      <ContextualSidebar />
    </>
  );
}
