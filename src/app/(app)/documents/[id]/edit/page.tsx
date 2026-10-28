import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, AlertCircle } from "lucide-react";
import type { EntityType } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import {
  onlyofficeConfigured, onlyofficeServerUrl, appBaseUrl, onlyofficeDocType, fileExt, makeDocReadToken, makeSaveToken, signJwt,
} from "@/lib/onlyoffice";
import { OfficeEditor } from "@/app/(app)/drive/[id]/edit/office-editor";
import { estDocumentVierge } from "@/lib/onlyoffice-config";
import { BackLink } from "@/components/shared/back-link";

export const dynamic = "force-dynamic";

// Retour vers la page de l'entité propriétaire du document (sinon la bibliothèque).
const ENTITY_ROUTE: Partial<Record<EntityType, string>> = {
  REGULATORY_PRODUCT: "/regulatory",
  DOSSIER: "/dossiers",
  SPONSORING: "/sponsoring",
  SUPPORT_REQUEST: "/support",
  CONGRESS_INTERNATIONAL: "/congress-international",
  CONGRESS_NATIONAL: "/congress-national",
  MEDICAL_INFO_DECLARATION: "/information-medicale",
  ADMIN_REQUEST: "/demandes",
  BD_PROJECT: "/business-development",
};

function Notice({ children, back }: { children: React.ReactNode; back: string }) {
  return (
    <div className="mx-auto max-w-lg space-y-3 py-10">
      <BackLink href={back}>
        <ArrowLeft className="h-4 w-4" /> Retour
      </BackLink>
      <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 px-4 py-3 text-sm">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> <div className="min-w-0 [overflow-wrap:anywhere]">{children}</div>
      </div>
    </div>
  );
}

export default async function DocumentEditPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireUser();

  const doc = await prisma.document.findUnique({
    where: { id: params.id },
    select: { name: true, version: true, fileKey: true, entityType: true, entityId: true, sizeBytes: true },
  });
  if (!doc) notFound();

  const backHref = ENTITY_ROUTE[doc.entityType] ? `${ENTITY_ROUTE[doc.entityType]}/${doc.entityId}` : "/documents";

  if (!onlyofficeConfigured()) {
    return <Notice back={backHref}>L'éditeur Office n'est pas configuré. Définissez <code>ONLYOFFICE_URL</code> (URL publique du Document Server) et <code>ONLYOFFICE_JWT_SECRET</code> côté serveur.</Notice>;
  }
  const base = appBaseUrl();
  if (!base) {
    return <Notice back={backHref}>L'URL publique de l'application (<code>APP_URL</code>) n'est pas définie : le Document Server doit pouvoir joindre l'application.</Notice>;
  }
  // Édition = même droit que le téléversement d'une pièce sur l'entité propriétaire.
  if (!(await canAccessEntity(user, doc.entityType, doc.entityId, "UPLOAD"))) {
    return <Notice back={backHref}>Vous n'avez pas le droit de modifier ce document.</Notice>;
  }
  if (!doc.fileKey) {
    return <Notice back={backHref}>Aucun fichier binaire associé à ce document.</Notice>;
  }
  const docType = onlyofficeDocType(doc.name);
  if (!docType) {
    return <Notice back={backHref}>Ce type de fichier n'est pas éditable dans l'éditeur Office.</Notice>;
  }

  // LIRE n'est pas ENREGISTRER (`lib/onlyoffice.ts`) : jeton de lecture dans `document.url` (qui part au
  // navigateur), jeton d'enregistrement dans `callbackUrl` seulement.
  const readToken = makeDocReadToken(params.id, user.id);
  const saveToken = makeSaveToken("document", params.id, user.id);
  // `key` change à chaque version → invalide le cache du Document Server après sauvegarde.
  const key = `doc_${params.id}_${doc.version}`;

  const config: Record<string, unknown> = {
    documentType: docType,
    document: {
      fileType: fileExt(doc.name),
      key,
      title: doc.name,
      url: `${base}/api/onlyoffice/file?token=${readToken}`,
      permissions: { edit: true, download: true, print: true },
    },
    editorConfig: {
      mode: "edit",
      lang: "fr",
      callbackUrl: `${base}/api/onlyoffice/callback?docId=${params.id}&token=${saveToken}`,
      user: { id: user.id, name: user.name },
      customization: { autosave: true, forcesave: true },
    },
    width: "100%",
    height: "100%",
  };
  const signed = { ...config, token: signJwt(config, 24 * 3600) };

  const src = `/api/documents/${encodeURIComponent(params.id)}`;
  return (
    <OfficeEditor
      apiJs={`${onlyofficeServerUrl()}/web-apps/apps/api/documents/api.js`} config={signed} name={doc.name} backHref={backHref} backLabel="Retour"
      apercu={{ src, telechargement: `${src}?dl=1`, vierge: estDocumentVierge(doc.name, doc.sizeBytes, doc.version) }}
      diagnostic={user.role === "SUPER_ADMIN"}
    />
  );
}
