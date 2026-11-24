import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileText } from "lucide-react";
import { requireUser } from "@/lib/session";
import { filDuSujetPec, pageAchat, tientLesMontantsDe } from "../../infra/requetes/achats-pec";
import { AcheterBc } from "./achats-acheter";
import { FilSujetPec } from "./achats-fil";

/**
 * LA PAGE « ACHETER — BC n°k » D'UNE PRISE EN CHARGE (24/11/2026) — la fiche que la ligne « Achat — BC n°k » du bureau du
 * secrétariat ouvre : les lignes de CE BC (et elles seules), les dépôts, le retrait, « Remboursé ? », le paiement.
 */
export async function PageAcheterPec({ scope, id, numero }: { scope: "NATIONAL" | "INTERNATIONAL"; id: string; numero: string }) {
  const user = await requireUser();
  const n = Number(numero);
  if (!Number.isInteger(n) || n < 1) notFound();
  if (!(await tientLesMontantsDe(user, scope, id))) notFound();
  const vue = await pageAchat(scope, id, n);
  if (!vue) notFound();
  const fil = await filDuSujetPec(scope, id);
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <Link href="/demandes" className="inline-flex items-center gap-1 text-sm text-primary hover:underline"><ArrowLeft className="h-4 w-4" /> Bureau du secrétariat</Link>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold [overflow-wrap:anywhere]">Acheter — BC n°{vue.numero}{vue.reference ? ` (${vue.reference})` : ""}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{[vue.nom, vue.dates, vue.phrase].filter(Boolean).join(" · ")}</p>
        </div>
        {vue.pdf && <a href={vue.pdf} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"><FileText className="h-4 w-4" /> Voir le PDF</a>}
      </header>
      {!vue.signeFinances && <p className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">Ce BC n&apos;est pas encore signé par les Finances : rien ne s&apos;achète avant leur signature.</p>}
      <AcheterBc vue={vue} />
      <FilSujetPec fil={fil} />
    </div>
  );
}
