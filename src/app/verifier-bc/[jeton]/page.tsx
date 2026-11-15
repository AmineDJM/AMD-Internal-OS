import { notFound } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { verificationDuJeton } from "@/lib/signature-en-ligne/signer-bc";
import { ComparerEmpreinte } from "./comparer-empreinte";

export const dynamic = "force-dynamic";
export const metadata = { title: "Vérification d'un bon de commande — Adventum Pharma", robots: { index: false } };

/**
 * VÉRIFIER UN BON DE COMMANDE SIGNÉ EN LIGNE (Direction, 15/11/2026) — page PUBLIQUE, ouverte par le QR du sceau. Elle dit
 * si la signature existe, qui a signé et quand, et l'empreinte du PDF : l'agence dépose le fichier reçu, son empreinte est
 * calculée DANS son navigateur et comparée. Ni le montant, ni les lignes, ni aucune autre donnée interne ne sont montrés.
 */
export default async function VerifierBcPage(props: { params: Promise<{ jeton: string }> }) {
  const { jeton } = await props.params;
  const v = await verificationDuJeton(jeton);
  if (!v) notFound();
  const signatures = v.signatures;
  const derniere = signatures[signatures.length - 1];
  const fr = (d: Date) => d.toLocaleString("fr-FR", { timeZone: "Africa/Algiers", dateStyle: "long", timeStyle: "short" });
  return (
    <main className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto max-w-2xl space-y-5">
        <div className="flex items-center gap-2 text-sm font-semibold text-primary">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded bg-primary text-xs text-primary-foreground">A</span>
          {v.emetteur ?? "Adventum Pharma"}
        </div>
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold"><ShieldCheck className="h-5 w-5 text-success" /> Bon de commande {v.reference ?? ""}</h1>
          <p className="text-sm text-muted-foreground">
            {v.annule ? "Ce bon de commande a été ANNULÉ par son émetteur." : "Ce bon de commande a été signé électroniquement dans l'ERP de l'émetteur."}
          </p>
        </div>
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {signatures.map((s) => (
            <li key={s.jeton} className="space-y-0.5 p-3 text-sm">
              <p className="font-medium">{s.signataireNom} — {s.qualite === "FINANCES" ? "Finances" : "Direction Marketing"}</p>
              <p className="text-muted-foreground">Signé et cacheté le {fr(s.signedAt)}</p>
            </li>
          ))}
        </ul>
        {derniere?.empreinte && (
          <div className="space-y-2 rounded-xl border border-border bg-card p-3 text-sm">
            <p className="font-medium">Empreinte du PDF signé (SHA-256)</p>
            <p className="break-all font-mono text-xs">{derniere.empreinte}</p>
            <ComparerEmpreinte attendue={derniere.empreinte} />
          </div>
        )}
      </div>
    </main>
  );
}
