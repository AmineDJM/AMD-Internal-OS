import { notFound } from "next/navigation";
import { ArrowLeft, AlertCircle } from "lucide-react";
import { requireUser } from "@/lib/session";
import { buildEditorSetup, EDITOR_REASON } from "@/lib/onlyoffice-config";
import { OfficeEditor } from "./office-editor";
import { BackLink } from "@/components/shared/back-link";

export const dynamic = "force-dynamic";

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-lg space-y-3 py-10">
      <BackLink href="/drive">
        <ArrowLeft className="h-4 w-4" /> Retour au Drive
      </BackLink>
      <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 px-4 py-3 text-sm">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> <div>{children}</div>
      </div>
    </div>
  );
}

export default async function DriveEditPage({ params }: { params: { id: string } }) {
  const user = await requireUser();
  const setup = await buildEditorSetup(user, params.id);
  if (!setup.ok) {
    if (setup.reason === "not-found") notFound();
    return <Notice>{EDITOR_REASON[setup.reason]}</Notice>;
  }
  const src = `/api/drive/${encodeURIComponent(params.id)}/raw`;
  return (
    <OfficeEditor
      apiJs={setup.apiJs} config={setup.config} name={setup.name}
      apercu={{ src, telechargement: `${src}?dl=1`, vierge: setup.vierge }}
      diagnostic={user.role === "SUPER_ADMIN"}
    />
  );
}
