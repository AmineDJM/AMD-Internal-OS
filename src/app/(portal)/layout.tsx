import type { Metadata } from "next";
import { PrimitivesUI } from "@/components/ui/primitives-ui";

export const metadata: Metadata = {
  title: "Portail Fournisseur — Adventum Pharma",
  description: "Suivi de l'enregistrement de vos produits auprès d'Adventum Pharma.",
};

/**
 * Shell du PORTAIL FOURNISSEUR — volontairement minimal et isolé : aucune
 * navigation interne, aucun composant du back-office. Les fournisseurs n'ont
 * accès qu'à ce groupe de routes.
 */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-muted/30">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <PrimitivesUI>{children}</PrimitivesUI>
      </div>
    </div>
  );
}
