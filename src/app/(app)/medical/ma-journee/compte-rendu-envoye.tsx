"use client";

import * as React from "react";
import Link from "next/link";
import { Pencil, ShieldAlert } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { cn } from "@/lib/utils";
import { ecarterAlertePvVisite } from "@/lib/actions/visite-pv-ecart-actions";
import { lienCasPvKam, lienSignalerPv } from "@/lib/chemins/rapports-terrain";
import { etatLectureIa, etatRelecture } from "@/lib/sfe/compte-rendu-envoye";
import type { LigneVue } from "./types-visite";

const jourCourt = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });

const CADRE_IA: Record<"neutral" | "danger" | "success" | "warning", string> = {
  neutral: "border-border bg-card",
  danger: "border-destructive/40 bg-destructive/5",
  success: "border-success/40 bg-success/5",
  warning: "border-warning/40 bg-warning/5",
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE COMPTE RENDU ENVOYÉ (interface du délégué, maquette VALIDÉE le 24/11/2026) — ce que le délégué a envoyé, ce que
 * l'IA y a lu, ce que son superviseur en a dit. Ouvert par « Voir » sur une visite faite de « Ma journée ».
 *
 *   • « Ce que vous avez envoyé », et « Corriger » tant que la fenêtre de 48 h est ouverte (ensuite il fait foi) ;
 *   • la LECTURE PAR L'IA : un possible cas de pharmacovigilance se montre avec la PHRASE relevée, et deux gestes —
 *     « Déclarer un PV (prérempli) » (le formulaire de signalement, rattaché à CETTE visite) et « Ce n'est pas un cas »
 *     (tracé, lu par le superviseur, qui garde le rapport en priorité) ;
 *   • la RELECTURE du superviseur et son mot.
 * L'écran n'invente aucun état : tout vient de la visite (`lecture`), relue par le serveur à chaque rafraîchissement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function CompteRenduEnvoye({
  ligne, onClose, onCorriger, peutSignalerPv,
}: {
  ligne: LigneVue | null;
  onClose: () => void;
  /** Rouvre le formulaire en correction — offert tant que la fenêtre de 48 h court. */
  onCorriger: (l: LigneVue) => void;
  peutSignalerPv: boolean;
}) {
  const { run, saving, err, setErr } = useAction();
  React.useEffect(() => { setErr(null); }, [ligne?.id, setErr]);
  const lecture = ligne?.lecture ?? null;
  const ia = lecture ? etatLectureIa(lecture) : null;
  const relecture = lecture ? etatRelecture(lecture) : null;
  const remis = ligne ? [
    ...ligne.remises.materiel.map((m) => `${m.libelle} × ${m.quantite.toLocaleString("fr-FR")}`),
    ...ligne.remises.numeriques.map((n) => `${n.libelle} (présenté)`),
  ] : [];
  const lignes: { k: string; v: string }[] = ligne ? [
    { k: "Produits présentés", v: ligne.produits.join(", ") || "—" },
    { k: "Messages portés", v: ligne.messages.join(" · ") || "—" },
    { k: "Compte rendu", v: ligne.rapport ?? (ligne.vocal ? "Rapport vocal rattaché" : "—") },
    { k: "Remis au médecin", v: remis.join(", ") || "rien" },
    ...(ligne.objections ? [{ k: "Objections", v: ligne.objections }] : []),
    ...(ligne.suite ? [{ k: "Ce qu'il reste à faire", v: ligne.suite }] : []),
  ] : [];

  return (
    <Sheet
      open={ligne !== null}
      onClose={onClose}
      title={ligne?.doctorName ?? ""}
      description={ligne ? `Compte rendu envoyé — visite du ${jourCourt(ligne.date)}` : ""}
      width="md"
      pleinEcran
    >
      {ligne && (
        <div className="space-y-4">
          <section aria-labelledby="cr-envoye" className="space-y-3 rounded-lg border border-border p-3">
            <h3 id="cr-envoye" className="text-sm font-semibold">Ce que vous avez envoyé</h3>
            <dl className="space-y-2.5 text-sm">
              {lignes.map((l) => (
                <div key={l.k}>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{l.k}</dt>
                  <dd className="mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{l.v}</dd>
                </div>
              ))}
            </dl>
            {ligne.heuresRestantes > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" className="h-10 sm:h-8" onClick={() => onCorriger(ligne)}>
                  <Pencil className="h-3.5 w-3.5" /> Corriger
                </Button>
                <span className="text-xs text-muted-foreground">Encore {ligne.heuresRestantes} h ; ensuite le compte rendu fait foi.</span>
              </div>
            )}
          </section>

          {ia && lecture && (
            <section aria-labelledby="cr-ia" className={cn("space-y-2.5 rounded-lg border p-3", CADRE_IA[ia.ton])}>
              <p className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral" dot={false}>IA</Badge>
                <span id="cr-ia" className="text-sm font-semibold">{ia.titre}</span>
              </p>
              <p className="text-sm text-muted-foreground">{ia.texte}</p>
              {ia.citation && (
                <blockquote className="rounded-r-lg border-l-[3px] border-destructive bg-card px-3 py-2 text-sm [overflow-wrap:anywhere]">
                  « {ia.citation} »
                </blockquote>
              )}
              {ia.gestes && (
                <div className="flex flex-wrap gap-2">
                  {peutSignalerPv && ligne.doctorId && (
                    <Link
                      href={lienSignalerPv(ligne.doctorId, ligne.id)}
                      className="inline-flex min-h-10 items-center gap-2 rounded-md bg-destructive px-3 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 sm:min-h-9"
                    >
                      <ShieldAlert className="h-4 w-4" aria-hidden /> Déclarer un PV (prérempli)
                    </Link>
                  )}
                  <BoutonDecisif
                    type="button" variant="outline" className="h-10 sm:h-9" disabled={saving}
                    confirmation="indiquer que ce n'est pas un cas"
                    onClick={() => {
                      const fd = new FormData();
                      fd.set("visitId", ligne.id);
                      void run(() => ecarterAlertePvVisite(fd), undefined, { succes: "Noté. Votre superviseur tranchera à la relecture." });
                    }}
                  >
                    Ce n&apos;est pas un cas
                  </BoutonDecisif>
                </div>
              )}
              {ia.sorte === "DECLARE" && lecture.cas && (
                <Link href={lienCasPvKam(lecture.cas.id)} className="inline-flex min-h-10 items-center text-sm font-medium text-primary hover:underline sm:min-h-0">
                  Voir le cas {lecture.cas.reference ?? ""}
                </Link>
              )}
              {err && <Retour ton="erreur">{err}</Retour>}
            </section>
          )}

          {relecture && lecture && (
            <section aria-labelledby="cr-relu" className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="cr-relu" className="text-sm font-semibold">Relecture par votre superviseur</h3>
                <Badge tone={relecture.ton}>{relecture.libelle}</Badge>
              </div>
              <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                {lecture.relu
                  ? `${lecture.relu.par ?? "Votre superviseur"}, le ${new Date(lecture.relu.le).toLocaleDateString("fr-FR")}${lecture.relu.mot ? ` : « ${lecture.relu.mot} »` : " — sans commentaire."}`
                  : "Son mot éventuel arrivera ici et dans « Retours du superviseur »."}
              </p>
            </section>
          )}
        </div>
      )}
    </Sheet>
  );
}
