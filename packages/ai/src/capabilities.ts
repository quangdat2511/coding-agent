export interface ModelCapabilities {
  readonly parallelToolCallControl: boolean;
  readonly cancellation: "client_abort_only" | "native_in_flight";
  readonly toolArgumentDelivery: "streamed" | "whole";
  readonly usageTiming: "incremental" | "final";
  readonly serverSideTools: boolean;
}
