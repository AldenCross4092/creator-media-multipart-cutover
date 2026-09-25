export type DeliveryDecision = {
  asset_status: "processing" | "awaiting_upload";
  processing_job: "transcode-and-package" | null;
  subscriber_update: "publish-when-ready" | "hold";
};

export function decideDelivery(objectFound: boolean, subscriberCount: number): DeliveryDecision {
  if (!objectFound) {
    return {
      asset_status: "awaiting_upload",
      processing_job: null,
      subscriber_update: "hold",
    };
  }

  return {
    asset_status: "processing",
    processing_job: "transcode-and-package",
    subscriber_update: subscriberCount > 0 ? "publish-when-ready" : "hold",
  };
}
