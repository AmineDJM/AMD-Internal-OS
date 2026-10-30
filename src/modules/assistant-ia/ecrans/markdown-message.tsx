"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Copy } from "lucide-react";
import { analyserMarkdown, type MdBlock, type MdInline } from "../domaine/ui/markdown";
import { cn } from "@/lib/utils";

/**
 * LE TEXTE D'UNE RÉPONSE DE L'ASSISTANT IA — Markdown analysé (`lib/agent/ui/markdown.ts`), puis
 * dessiné par nos propres composants. Aucun HTML venu du modèle n'est interprété ; un lien ne mène
 * qu'à https, mailto ou un chemin interne de l'ERP.
 *
 * MOBILE D'ABORD : un tableau de plusieurs colonnes devient, sous 640 px, une fiche par ligne
 * (première cellule en titre, chaque autre valeur sous son intitulé) — quatre colonnes sur 390 px
 * coupaient les mots syllabe par syllabe.
 */

function Lien({ href, children }: { href: string; children: React.ReactNode }) {
  const classe = "font-medium text-blue-700 underline decoration-blue-700/30 underline-offset-2 hover:decoration-blue-700 dark:text-blue-400";
  if (/^\/api\/drive\/[^/]+\/raw/.test(href)) return <a href={href} download className={classe}>{children}</a>;
  if (href.startsWith("/")) return <Link href={href} className={classe}>{children}</Link>;
  return <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={classe}>{children}</a>;
}

function EnLigne({ xs }: { xs: MdInline[] }) {
  return (
    <>
      {xs.map((x, i) => {
        switch (x.t) {
          case "texte": return <React.Fragment key={i}>{x.v}</React.Fragment>;
          case "saut": return <br key={i} />;
          case "gras": return <strong key={i} className="font-semibold text-slate-900 dark:text-zinc-50"><EnLigne xs={x.c} /></strong>;
          case "italique": return <em key={i}><EnLigne xs={x.c} /></em>;
          case "barre": return <del key={i} className="opacity-70"><EnLigne xs={x.c} /></del>;
          case "code": return <code key={i} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em] text-slate-800 [overflow-wrap:anywhere] dark:bg-zinc-800 dark:text-zinc-200">{x.v}</code>;
          case "lien": return <Lien key={i} href={x.href}><EnLigne xs={x.c} /></Lien>;
        }
      })}
    </>
  );
}

function BoutonCopier({ texte }: { texte: string }) {
  const [copie, setCopie] = React.useState(false);
  return (
    <button
      type="button"
      onClick={() => { void navigator.clipboard?.writeText(texte).then(() => { setCopie(true); setTimeout(() => setCopie(false), 1500); }); }}
      className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-slate-500 hover:bg-white hover:text-slate-900 dark:hover:bg-zinc-800"
      aria-label="Copier"
    >
      {copie ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copie ? "Copié" : "Copier"}
    </button>
  );
}

function alignement(a: "gauche" | "centre" | "droite" | null): string {
  return a === "droite" ? "text-right tabular-nums" : a === "centre" ? "text-center" : "";
}

function Tableau({ b }: { b: Extract<MdBlock, { t: "tableau" }> }) {
  return (
    <>
      <ul className="space-y-2 sm:hidden" aria-label="Tableau">
        {b.lignes.map((r, i) => (
          <li key={i} className="rounded-xl border border-slate-200 bg-white/80 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/80">
            <div className="font-semibold text-slate-900 [overflow-wrap:anywhere] dark:text-zinc-50"><EnLigne xs={r[0] ?? []} /></div>
            <dl className="mt-1.5 space-y-1.5">
              {r.slice(1).map((c, k) => (c.length === 0 ? null : (
                <div key={k}>
                  <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-zinc-400"><EnLigne xs={b.entete[k + 1] ?? []} /></dt>
                  <dd className="[overflow-wrap:anywhere]"><EnLigne xs={c} /></dd>
                </div>
              )))}
            </dl>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-xl border border-slate-200 sm:block dark:border-zinc-800">
        <table className="w-full border-collapse text-[13px]">
          <thead className="bg-slate-50 text-left dark:bg-zinc-900">
            <tr>{b.entete.map((c, k) => <th key={k} scope="col" className={cn("px-3 py-2 font-semibold", alignement(b.align[k]))}><EnLigne xs={c} /></th>)}</tr>
          </thead>
          <tbody>
            {b.lignes.map((r, i) => (
              <tr key={i} className="border-t border-slate-200 dark:border-zinc-800">
                {r.map((c, k) => <td key={k} className={cn("px-3 py-2 align-top [overflow-wrap:anywhere]", alignement(b.align[k]))}><EnLigne xs={c} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Bloc({ b }: { b: MdBlock }) {
  switch (b.t) {
    case "paragraphe":
      return <p className="[overflow-wrap:anywhere]"><EnLigne xs={b.c} /></p>;
    case "titre": {
      const classes = { 1: "text-base font-semibold", 2: "text-[15px] font-semibold", 3: "text-sm font-semibold", 4: "text-xs font-semibold uppercase tracking-wide text-slate-500" } as const;
      const Balise = (["h3", "h3", "h4", "h5"] as const)[b.niveau - 1];
      return <Balise className={cn("mt-1 text-slate-900 dark:text-zinc-50", classes[b.niveau])}><EnLigne xs={b.c} /></Balise>;
    }
    case "liste": {
      const contenu = b.items.map((it, k) => (
        <li key={k} className="pl-1 [&>div>p]:inline"><Blocs blocs={it} compact /></li>
      ));
      return b.ordonnee
        ? <ol start={b.debut} className="list-decimal space-y-1 pl-5 marker:text-slate-400">{contenu}</ol>
        : <ul className="list-disc space-y-1 pl-5 marker:text-slate-400">{contenu}</ul>;
    }
    case "tableau":
      return <Tableau b={b} />;
    case "code":
      return (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-1 text-xs text-slate-500 dark:border-zinc-800">
            <span>{b.langue || "texte"}</span>
            <BoutonCopier texte={b.v} />
          </div>
          <pre className="overflow-x-auto p-3 text-[12.5px] leading-relaxed"><code className="font-mono">{b.v}</code></pre>
        </div>
      );
    case "citation":
      return <blockquote className="border-l-2 border-slate-300 pl-3 text-slate-600 dark:border-zinc-600 dark:text-zinc-400"><Blocs blocs={b.c} compact /></blockquote>;
    case "separateur":
      return <hr className="border-slate-200 dark:border-zinc-800" />;
  }
}

function Blocs({ blocs, compact }: { blocs: MdBlock[]; compact?: boolean }) {
  return (
    <div className={cn("min-w-0", compact ? "space-y-1" : "space-y-2.5")}>
      {blocs.map((b, i) => <Bloc key={i} b={b} />)}
    </div>
  );
}

export function MarkdownMessage({ texte, className }: { texte: string; className?: string }) {
  const blocs = React.useMemo(() => analyserMarkdown(texte), [texte]);
  return (
    <div className={cn("min-w-0", className)}>
      <Blocs blocs={blocs} />
    </div>
  );
}
