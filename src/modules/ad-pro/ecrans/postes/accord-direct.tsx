"use client";

import * as React from "react";
import { FileCheck2, Loader2, Sparkles } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { lireDevisAvantDepot } from "../../actions-postes-paiement";

/**
 * LA PIÈCE D'UN POSTE PAYÉ DIRECTEMENT, À L'ACCORD (Direction, 23/11/2026) — le montant et le bénéficiaire ne se saisissent
 * plus à l'ajout du poste : ils viennent de la PRO FORMA ou de la FACTURE. Déjà sur le poste (déposée dans sa case), elle
 * se lit ; sinon la Direction Marketing la joint ici, l'IA la lit (`lireDevisAvantDepot` — rien n'est écrit), les champs se
 * remplissent, elle confirme. La pièce part avec l'accord (`decideAdProItem`, champ `proforma`) et se range dans la case
 * « Justificatif » du poste : la demande de paiement n'aura plus rien à joindre.
 */
export function PieceDeLAccordDirect({ itemId, surLePoste, fichier, onFichier, onLu }: {
  itemId: string;
  /** La pro forma déjà déposée sur le poste (la plus récente non annulée), avec ce qu'on en sait. */
  surLePoste: { titre: string; montant: number | null; fournisseur: string | null } | null;
  fichier: File | null;
  onFichier: (f: File | null) => void;
  /** Ce que la pièce dit — ce qui pré-remplit « Montant accordé » et « Payé à ». */
  onLu: (lu: { montant: number | null; fournisseur: string | null }) => void;
}) {
  const [lecture, setLecture] = React.useState<{ etat: "lecture" | "lu" | "echec"; phrase: string } | null>(null);
  if (surLePoste) {
    return (
      <p className="flex items-start gap-1.5 rounded-md bg-secondary/50 px-2 py-1.5 text-xs">
        <FileCheck2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
        <span>
          Pièce sur le poste : <span className="font-medium">{surLePoste.titre}</span>
          {surLePoste.montant != null && <> · {formatCurrency(surLePoste.montant)}</>}
          {surLePoste.fournisseur && <> · {surLePoste.fournisseur}</>}
          {" "}— le montant et le bénéficiaire en sont repris.
        </span>
      </p>
    );
  }
  const lire = async (f: File) => {
    setLecture({ etat: "lecture", phrase: "L'IA lit la pièce…" });
    const fd = new FormData();
    fd.set("id", itemId);
    fd.set("fichier", f);
    let r: Awaited<ReturnType<typeof lireDevisAvantDepot>>;
    try {
      r = await lireDevisAvantDepot(fd);
    } catch {
      r = { ok: false, raison: "La lecture a échoué : remplissez le montant et le bénéficiaire depuis le papier." };
    }
    if (!r.ok) { setLecture({ etat: "echec", phrase: r.raison }); return; }
    onLu({ montant: r.montant, fournisseur: r.fournisseur });
    setLecture({ etat: "lu", phrase: r.phrase });
  };
  return (
    <div className="space-y-1.5 text-xs">
      <label className="block">
        Pro forma ou facture <span className="text-muted-foreground">— le montant et le bénéficiaire s&apos;y lisent</span>
        <input
          type="file" accept=".pdf,image/*,.doc,.docx" className="mt-1 block w-full text-xs" aria-label="Pro forma ou facture du poste"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            onFichier(f);
            if (f) void lire(f);
            else setLecture(null);
          }}
        />
      </label>
      {fichier && lecture && (
        <p className={`flex items-start gap-1.5 rounded-md px-2 py-1.5 ${lecture.etat === "echec" ? "bg-warning/10" : "bg-luna/10"}`}>
          {lecture.etat === "lecture" ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-luna" /> : <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-luna" />}
          <span>{lecture.phrase}</span>
        </p>
      )}
    </div>
  );
}
