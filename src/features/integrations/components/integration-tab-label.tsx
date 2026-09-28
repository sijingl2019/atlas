/**
 * An integration tab's icon and title, read live: a tab's stored title is
 * whatever it was when opened (and is restored across launches), so a
 * renamed project or a changed source would otherwise never reach it.
 */
import { Cable } from "lucide-react";
import { basename } from "@/lib/paths";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useIntegrationsStore } from "../lib/integrations";
import { SourceIcon } from "./source-icon";

function useItem(id: string) {
  return useIntegrationsStore((s) => s.items.find((i) => i.id === id));
}

export function IntegrationTabIcon({ integrationId }: { integrationId: string }) {
  const item = useItem(integrationId);
  return item ? (
    <SourceIcon kind={item.source.kind} size={12} />
  ) : (
    <Cable size={12} className="shrink-0 text-muted-foreground" />
  );
}

export function IntegrationTabTitle({
  integrationId,
  fallback,
}: {
  integrationId: string;
  fallback: string;
}) {
  const item = useItem(integrationId);
  const projectName = useProjectStore((s) =>
    item ? s.projects.find((p) => p.id === item.projectId)?.name : undefined,
  );
  if (!item) return <>{fallback}</>;
  return <>{projectName ?? basename(item.projectPath)}</>;
}
