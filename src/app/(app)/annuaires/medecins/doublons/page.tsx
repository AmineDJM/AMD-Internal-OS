import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { peutDeciderFusionMedecins, propositionsFusionMedecins } from "@/modules/referentiels/api";
import { LIBELLE_CHAMP_FUSION, type ChampFusion } from "@/modules/referentiels/partage";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DecisionDoublon } from "./decision";

export const dynamic = "force-dynamic";
export const metadata = { title: "Annuaires — Médecins en double — AMD Internal OS" };

/**
 * LES FICHES MÉDECINS EN DOUBLE — la liste du SUPER ADMIN (lot T2, décision 0061).
 *
 * « Toi, tu me proposes juste tout […] j'ai juste à cliquer une croix ou une validation et ça valide » (Direction,
 * 03/11). Chaque ligne : la fiche gardée, la fiche absorbée, les champs que la première recevra, ce qui est rattaché à
 * la seconde. ✓ fusionne (réversible : la barre « Annuler » et l'historique le défont) ; ✗ écarte — la paire ne
 * revient que si l'une des fiches change. Pour tout autre compte, la page n'existe pas.
 */
const RATTACHE: Record<string, string> = { visites: "visite", rapportsTerrain: "rapport terrain", demandesAdPro: "demande Ad & Pro", remisesMateriel: "remise de matériel", segmentation: "élément de segmentation" };
const rattaches = (r: Record<string, number>) => Object.entries(r).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${RATTACHE[k] ?? k}${n > 1 ? "s" : ""}`).join(", ") || "rien de rattaché";
const fiche = (f: { name: string; specialite: string | null; wilaya: string | null; phone: string | null; delegue: string | null }) =>
  [f.specialite, f.wilaya, f.phone, f.delegue ? `délégué ${f.delegue}` : null].filter(Boolean).join(" · ");

export default async function DoublonsMedecinsPage() {
  const user = await requireUser();
  if (!peutDeciderFusionMedecins(user)) notFound();
  const propositions = await propositionsFusionMedecins(user);
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div>
        <h1 className="text-xl font-semibold">Fiches médecins en double</h1>
        <p className="text-sm text-muted-foreground">
          {propositions.length ? `${propositions.length} proposition(s). ✓ fusionne (réversible), ✗ écarte la proposition.` : "Aucune fiche en double à trancher."}
        </p>
      </div>
      {propositions.map((p) => (
        <Card key={p.cle}>
          <CardHeader>
            <CardTitle className="text-base">Garder « {p.garde.name} » · absorber « {p.absorbee.name} »</CardTitle>
            <CardDescription>{p.raisons.join(", ")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p><span className="font-medium">Gardée</span> — {fiche(p.garde) || "—"} ({rattaches(p.garde.rattaches)})</p>
            <p><span className="font-medium">Absorbée</span> — {fiche(p.absorbee) || "—"} ({rattaches(p.absorbee.rattaches)})</p>
            <p>
              <span className="font-medium">Reçoit</span> —{" "}
              {Object.keys(p.champsRecus).length
                ? Object.entries(p.champsRecus).map(([c, v]) => `${LIBELLE_CHAMP_FUSION[c as ChampFusion]} : ${v}`).join(" · ")
                : "aucun champ (la fiche gardée est déjà complète)"}
            </p>
            <DecisionDoublon gardeId={p.garde.id} absorbeId={p.absorbee.id} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
