import { createFileRoute } from "@tanstack/react-router";

import { PipelinesStudioPage } from "../pm/PipelinesStudio";

export const Route = createFileRoute("/_chat/pipelines")({
  component: PipelinesStudioPage,
});
