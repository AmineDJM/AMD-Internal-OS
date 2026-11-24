"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ancrePoste, lienPosteAssistante } from "@/lib/chemins/ad-pro";

/**
 * UN ANCIEN LIEN VERS UN POSTE (23/11/2026) — « /events/<id>#poste-<id> » : la fiche de la demande renvoie l'assistante à
 * son bureau (elle n'en a plus le module), et l'ancre survit à la redirection. Quand le poste est à elle, il s'ouvre sur SA
 * page ; sinon, elle reste sur le bureau. Rien ne s'affiche. Monté par le Bureau du secrétariat (24/11/2026).
 */
export function AncrePosteVersSaPage({ postes }: { postes: string[] }) {
  const router = useRouter();
  React.useEffect(() => {
    const prefixe = `#${ancrePoste("")}`;
    const hash = window.location.hash;
    if (!hash.startsWith(prefixe)) return;
    const id = decodeURIComponent(hash.slice(prefixe.length));
    if (postes.includes(id)) router.replace(lienPosteAssistante(id));
  }, [postes, router]);
  return null;
}
