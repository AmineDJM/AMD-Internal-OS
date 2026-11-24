import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/session";
import { filDuSujetPec, pageChiffrage, tientLesMontantsDe } from "../../infra/requetes/achats-pec";
import { GrilleChiffrage } from "./achats-grille";
import { FilSujetPec } from "./achats-fil";

/**
 * LA PAGE « CHIFFRER » D'UNE PRISE EN CHARGE (maquette Chiffrage, 24/11/2026) — la fiche que la ligne « Chiffrage » du bureau
 * du secrétariat ouvre. Pour l'assistante sollicitée et la Direction Marketing (`tientLesMontantsDe`) ; les autres n'y voient rien.
 */
export async function PageChiffrerPec({ scope, id }: { scope: "NATIONAL" | "INTERNATIONAL"; id: string }) {
  const user = await requireUser();
  if (!(await tientLesMontantsDe(user, scope, id))) notFound();
  const vue = await pageChiffrage(scope, id);
  if (!vue) notFound();
  const fil = await filDuSujetPec(scope, id);
  const pros = new Set(vue.lignes.map((l) => l.pro)).size;
  const demande = vue.chiffrage
    ? `Demandé${vue.chiffrage.demandePar ? ` par ${vue.chiffrage.demandePar}` : ""} le ${new Date(vue.chiffrage.demandeLe).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}`
    : "Aucune demande ouverte — les montants restent modifiables";
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <Link href="/demandes" className="inline-flex items-center gap-1 text-sm text-primary hover:underline"><ArrowLeft className="h-4 w-4" /> Bureau du secrétariat</Link>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold [overflow-wrap:anywhere]">Chiffrer — {vue.nom}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {[demande, `${pros} professionnel${pros > 1 ? "s" : ""} à chiffrer`, [vue.ville, vue.dates].filter(Boolean).join(", ") || null].filter(Boolean).join(" · ")}
          </p>
        </div>
        <span className="rounded-full border border-border bg-secondary/50 px-3 py-1 text-xs font-semibold">{vue.etatLibelle}</span>
      </header>
      <GrilleChiffrage vue={vue} />
      <FilSujetPec fil={fil} />
    </div>
  );
}
