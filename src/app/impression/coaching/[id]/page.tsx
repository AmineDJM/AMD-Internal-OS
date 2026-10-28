import { notFound } from "next/navigation";
import { requireModule } from "@/lib/session";
import { lecteurCoaching } from "@/lib/coaching/serveur";
import { chargerFicheVisible } from "@/lib/coaching/fiches";
import { formaterJour } from "@/lib/coaching/dates";
import { BilanLecture, EchelleNiveaux, GrilleEvaluation, TotalFiche } from "@/components/coaching/fiche-grille";
import { BoutonImprimer } from "@/components/coaching/fiche-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Fiche de coaching — impression" };

/**
 * LA FICHE À IMPRIMER / ENREGISTRER EN PDF (§118.157).
 *
 * Hors de la coque de l'application (menu, barres) : la page ne porte que la fiche, au format
 * d'une feuille A4. Le PDF est celui du NAVIGATEUR (« Enregistrer en PDF ») — il rend les
 * vraies polices et chaque caractère de la grille (« ➔ », « « » »), là où un rendu serveur en
 * polices standard les perdrait. La règle de lecture est la même que l'écran : une fiche
 * invisible est une page introuvable.
 */
export default async function ImpressionFicheCoaching(
  props: { params: Promise<{ id: string }>; searchParams?: Promise<{ auto?: string }> }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  // LA MÊME PORTE que l'écran (module masqué compris) : l'impression n'est pas une porte à côté.
  const user = await requireModule("MEDICAL");
  const l = await lecteurCoaching(user);
  const fiche = await chargerFicheVisible(l, params.id);
  if (!fiche || !fiche.grille) notFound();

  return (
    <main className="mx-auto max-w-[210mm] space-y-5 bg-white p-6 text-foreground print:max-w-none print:p-0">
      <style>{"@page { size: A4; margin: 12mm; } @media print { body { background: #fff; } }"}</style>
      <div className="flex items-center justify-end print:hidden">
        <BoutonImprimer auto={searchParams?.auto === "1"} />
      </div>
      <header className="space-y-3 border-b border-border pb-4">
        <h1 className="text-xl font-bold tracking-tight">{fiche.grille.titre}</h1>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2 print:grid-cols-2">
          <div><dt className="inline font-semibold">Collaborateur : </dt><dd className="inline">{fiche.collaborateur}</dd></div>
          <div><dt className="inline font-semibold">Manager : </dt><dd className="inline">{fiche.manager ?? "—"}</dd></div>
          <div><dt className="inline font-semibold">Date : </dt><dd className="inline">{formaterJour(fiche.visitDate)}</dd></div>
          <div><dt className="inline font-semibold">Secteur / Région / CDR : </dt><dd className="inline">{fiche.sector ?? "—"}</dd></div>
        </dl>
      </header>
      <EchelleNiveaux grille={fiche.grille} />
      <TotalFiche grille={fiche.grille} notes={fiche.notes} />
      <GrilleEvaluation grille={fiche.grille} notes={fiche.notes} nomGroupe={`impression-${fiche.id}`} />
      <BilanLecture grille={fiche.grille} strengths={fiche.strengths} improvements={fiche.improvements} />
      <footer className="border-t border-border pt-3 text-xs italic text-muted-foreground">
        {fiche.status === "FINALIZED"
          ? `Fiche finalisée${fiche.finalizedAt ? ` le ${fiche.finalizedAt.toLocaleDateString("fr-FR", { timeZone: "Africa/Algiers" })}` : ""}${fiche.finalisePar ? ` par ${fiche.finalisePar}` : ""}`
          : "BROUILLON — fiche non finalisée"}
        {` · Grille version ${fiche.gridVersion} · AMD Internal OS`}
      </footer>
    </main>
  );
}
