import { useBulkModal } from "./bulk-update-modal";
import { Button } from "../shared/button";

export const useBulkLocationUpdateModal = ({
  onClick,
}: {
  onClick: () => void;
}) => {
  const {
    BulkUpdateTrigger: BulkLocationUpdateTrigger,
    BulkUpdateModal: BulkLocationUpdateModal,
    disabled,
    handleCloseDialog,
  } = useBulkModal({
    key: "location",
    modalContent: <BulkLocationUpdateModalContent />,
    onClick,
  });

  function BulkLocationUpdateModalContent() {
    return (
      <>
        <div className=" relative z-50 mb-8">
          {/* @TODO - this is causing an endless re-render. Seems to be something in the hook useModelFilters */}
          {/* <LocationSelect isBulk /> */}
        </div>

        <div className="flex gap-3">
          <Button
            to=".."
            variant="secondary"
            width="full"
            disabled={disabled}
            onClick={handleCloseDialog}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            width="full"
            type="submit"
            disabled={disabled}
            name="intent"
            value="bulk-update-location"
          >
            Confirm
          </Button>
        </div>
      </>
    );
  }

  return [BulkLocationUpdateTrigger, BulkLocationUpdateModal];
};
