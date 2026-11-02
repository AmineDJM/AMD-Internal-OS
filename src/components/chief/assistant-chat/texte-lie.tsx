"use client";

/**
 * LA CONVERSATION — le texte d'une réponse dont les chemins internes de l'ERP deviennent cliquables.
 */
import * as React from "react";
import Link from "next/link";

/** Les chemins internes de l'ERP écrits DANS le texte d'une réponse — rendus cliquables. */
const INTERNAL_PATH_RE =
  /(\/(?:api\/drive|drive|regulatory|legal|rh|events|sponsoring|validations|centre-de-paiement|calendar|chief-of-staff|workspace|courriers|stocks|finances|messages|meetings)\/[A-Za-z0-9_\-/.?=&%]+)/g;

/**
 * Un lien écrit en clair (« Lien : /drive/xxx ») n'est un lien que s'il se CLIQUE.
 * Les chemins `/api/drive/…/raw` deviennent de vrais téléchargements ; les autres, des
 * navigations internes. La ponctuation finale (.,;:)»…) reste du texte.
 */
export function LinkifiedText({ text }: { text: string }) {
  const parts = text.split(INTERNAL_PATH_RE);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return <React.Fragment key={i}>{part}</React.Fragment>;
        const clean = part.replace(/[).,;:!?»…]+$/, "");
        const trail = part.slice(clean.length);
        const isDownload = /^\/api\/drive\/[^/]+\/raw/.test(clean);
        return (
          <React.Fragment key={i}>
            {isDownload ? (
              <a href={clean} download className="font-medium text-primary underline underline-offset-2 [overflow-wrap:anywhere] hover:opacity-80">
                {clean}
              </a>
            ) : (
              <Link href={clean} className="font-medium text-primary underline underline-offset-2 [overflow-wrap:anywhere] hover:opacity-80">
                {clean}
              </Link>
            )}
            {trail}
          </React.Fragment>
        );
      })}
    </>
  );
}
