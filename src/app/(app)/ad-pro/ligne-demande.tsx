"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { StatusBadge } from "@/components/shared/status-badge";
import { PartagerButton } from "@/components/shared/partager-button";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { AD_PRO_ENTITY_TYPE, AD_PRO_STATE, kindSpec } from "@/modules/ad-pro/partage";
import { attenteLongue, libelleDepuis, lireEcheance, type ColonneTri, type LigneAdPro, type Tri } from "./liste";

/**
 * UNE DEMANDE DANS LE TABLEAU — la ligne (bureau) et la carte (téléphone), qui disent la même chose :
 * la nature, l'objet et sa référence, qui demande, combien, où elle en est et chez qui, la prochaine date.
 */

const jourCourt = (iso: string) => formatDate(iso, { day: "numeric", month: "short", year: "numeric" });

/** La nature : une pastille discrète, son icône — la couleur reste aux ÉTATS. */
function Nature({ r, compacte = false }: { r: LigneAdPro; compacte?: boolean }) {
  const spec = kindSpec(r.kind);
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span aria-hidden className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
        <Icon name={spec?.icon ?? "CircleEllipsis"} className="h-3.5 w-3.5" />
      </span>
      <span className={cn("min-w-0 text-xs text-muted-foreground", compacte ? "truncate" : "leading-tight")}>{spec?.label ?? r.kind}</span>
    </span>
  );
}

/** « chez Direction Marketing · depuis 3 j », ou « À vous · depuis 3 j » quand c'est à la personne qui regarde. */
function OuEnEst({ r, maintenant }: { r: LigneAdPro; maintenant: number }) {
  const depuis = libelleDepuis(r.depuis, maintenant);
  if (!r.chezQui && !depuis) return null;
  return (
    <span className="block text-xs leading-snug text-muted-foreground [overflow-wrap:anywhere]" title={r.etape ?? undefined}>
      {r.aVous
        ? <span className="font-semibold text-primary">À vous</span>
        : r.chezQui && <>chez <span className="text-foreground/80">{r.chezQui}</span></>}
      {r.chezQui && depuis && " · "}
      {depuis && <span className={cn(attenteLongue(r.depuis, maintenant) && "text-warning")}>{depuis}</span>}
    </span>
  );
}

function Echeance({ r, maintenant }: { r: LigneAdPro; maintenant: number }) {
  const e = lireEcheance(r.echeance, maintenant);
  if (!e || !r.echeance) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="block leading-tight">
      <span className="whitespace-nowrap">{formatDate(r.echeance, { day: "numeric", month: "short" })}</span>
      <span className={cn("block text-xs", e.depassee ? "font-medium text-destructive" : e.proche ? "font-medium text-warning" : "text-muted-foreground")}>
        {e.relatif}
      </span>
    </span>
  );
}

/** L'échéance en une ligne, là où sa colonne n'a pas la place (téléphone, écran moyen). */
function EcheanceCompacte({ r, maintenant, className }: { r: LigneAdPro; maintenant: number; className?: string }) {
  const e = lireEcheance(r.echeance, maintenant);
  if (!e || !r.echeance) return null;
  return (
    <span className={cn("block text-xs", e.depassee ? "text-destructive" : e.proche ? "text-warning" : "text-muted-foreground", className)}>
      Échéance {formatDate(r.echeance, { day: "numeric", month: "short" })} · {e.relatif}
    </span>
  );
}

const Montant = ({ r }: { r: LigneAdPro }) =>
  r.amount !== null ? <span className="whitespace-nowrap tabular-nums">{formatCurrency(r.amount)}</span> : <span className="text-muted-foreground">—</span>;

/** Le geste de la ligne, qui existait avant la refonte : partager le dossier (le serveur vérifie l'accès à CET enregistrement). */
const Partager = ({ r }: { r: LigneAdPro }) => (
  <PartagerButton iconOnly variant="ghost" refType={AD_PRO_ENTITY_TYPE[r.kind]} refId={r.id} refLabel={`${r.reference} — ${r.title}`} href={r.href} />
);

/** Une ligne du bureau : entière cliquable ; l'objet reste un vrai lien (clavier, nouvel onglet). */
export function LigneDemande({ r, maintenant }: { r: LigneAdPro; maintenant: number }) {
  const router = useRouter();
  const ouvrir = (e: React.MouseEvent) => {
    // Un lien, un bouton (partager) ou une sélection de texte gardent leur geste à eux.
    if ((e.target as HTMLElement).closest("a, button, [role=dialog]")) return;
    if (window.getSelection()?.toString()) return;
    router.push(r.href);
  };
  const td = "border-b border-border px-3 py-3 align-top";
  return (
    <tr
      onClick={ouvrir}
      className={cn(
        "group cursor-pointer transition-colors duration-150 hover:bg-secondary/60 focus-within:bg-secondary/60",
        r.aVous && "bg-primary/[0.04] hover:bg-primary/[0.08]",
      )}
    >
      <td className={cn(td, "relative w-[11rem] pl-4")}>
        {/* Ce qui attend la personne connectée porte un liseré : l'œil le trouve sans lire. */}
        {r.aVous && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-primary" />}
        <Nature r={r} />
      </td>
      <td className={cn(td, "min-w-[14rem]")}>
        <Link href={r.href} className="font-semibold text-foreground underline-offset-2 [overflow-wrap:anywhere] hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {r.title}
        </Link>
        <span className="mt-0.5 block text-xs text-muted-foreground [overflow-wrap:anywhere]">
          <span className="font-mono">{r.reference}</span>
          {r.beneficiary && <> · {r.beneficiary}</>}
          {r.requester && <span className="lg:hidden"> · {r.requester}</span>}
        </span>
      </td>
      <td className={cn(td, "hidden lg:table-cell")}>
        <span className="block [overflow-wrap:anywhere]">{r.requester ?? <span className="text-muted-foreground">—</span>}</span>
        <span className="block text-xs text-muted-foreground">{jourCourt(r.createdAt)}</span>
      </td>
      <td className={cn(td, "text-right")}><Montant r={r} /></td>
      <td className={cn(td, "min-w-[11rem]")}>
        <span className="flex flex-col items-start gap-1">
          <StatusBadge map={AD_PRO_STATE} value={r.state} dot={false} />
          <OuEnEst r={r} maintenant={maintenant} />
          <EcheanceCompacte r={r} maintenant={maintenant} className="xl:hidden" />
        </span>
      </td>
      <td className={cn(td, "hidden w-[8rem] xl:table-cell")}><Echeance r={r} maintenant={maintenant} /></td>
      <td className={cn(td, "w-10 px-2 opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100")}><Partager r={r} /></td>
    </tr>
  );
}

/** La même demande au téléphone : une carte, toute la surface ouvre la fiche, rien ne déborde. */
export function CarteDemande({ r, maintenant }: { r: LigneAdPro; maintenant: number }) {
  return (
    <li
      className={cn(
        "relative rounded-xl border bg-card p-3 shadow-sm transition-colors duration-150 focus-within:ring-2 focus-within:ring-ring active:bg-secondary/60",
        r.aVous ? "border-primary/50 bg-primary/[0.03]" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <Nature r={r} compacte />
        <span className="shrink-0 text-sm font-medium"><Montant r={r} /></span>
      </div>
      <Link
        href={r.href}
        className="mt-2 block font-semibold leading-snug text-foreground [overflow-wrap:anywhere] after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:outline-none"
      >
        {r.title}
      </Link>
      <p className="mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
        <span className="font-mono">{r.reference}</span>
        {r.beneficiary && <> · {r.beneficiary}</>}
        {r.requester && <> · {r.requester}</>}
      </p>
      <div className="mt-2.5 flex items-end justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <StatusBadge map={AD_PRO_STATE} value={r.state} dot={false} />
          <OuEnEst r={r} maintenant={maintenant} />
          <EcheanceCompacte r={r} maintenant={maintenant} />
        </div>
        {/* Au-dessus du lien étiré : le partage reste un geste à part. */}
        <span className="relative z-10 shrink-0"><Partager r={r} /></span>
      </div>
    </li>
  );
}

/** Un en-tête qui trie : un clic croissant, un deuxième décroissant, un troisième rend l'ordre « ce qui attend d'abord ». */
export function EnteteTriable({ col, tri, onTri, align = "left", className, children }: {
  col: ColonneTri;
  tri: Tri | null;
  onTri: (col: ColonneTri) => void;
  align?: "left" | "right";
  className?: string;
  children: React.ReactNode;
}) {
  const actif = tri?.col === col;
  const Fleche = !actif ? ChevronsUpDown : tri!.sens === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={actif ? (tri!.sens === "asc" ? "ascending" : "descending") : "none"}
      className={cn("border-b border-border px-3 py-2.5 font-semibold", align === "right" && "text-right", className)}
    >
      <button
        type="button" onClick={() => onTri(col)}
        className={cn(
          "group/tri inline-flex items-center gap-1 rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          align === "right" && "flex-row-reverse",
          actif && "text-foreground",
        )}
      >
        {children}
        <Fleche aria-hidden className={cn("h-3.5 w-3.5 transition-opacity", actif ? "opacity-100" : "opacity-0 group-hover/tri:opacity-60 group-focus-visible/tri:opacity-60")} />
      </button>
    </th>
  );
}
