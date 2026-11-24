import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import type { EtapeBarre } from "../domaine/barre-etapes";
import { SectionRepliable, Sections } from "@/components/shared/section-repliable";
import { CarteDetailsDemande, type PiecesJointesDeLaDemande } from "./pieces-jointes-demande";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE GABARIT DE LA FICHE D'UNE DEMANDE AD & PRO (maquette « Fiche Ad & Pro » validée par le Super Admin, 24/11/2026).
 *
 *   1. l'en-tête : titre, une ligne grise « réf · demandé par X, rôle, le date », UN badge d'état, le menu « ⋯ » ;
 *   2. « Où en est la demande » : cinq étapes au plus (`barreDesEtapes`), l'étape en cours dit chez qui ;
 *   3. « À vous » : seulement quand la personne qui regarde a un geste à faire MAINTENANT — une phrase, le geste ;
 *   4. « La demande » : quatre faits et la description ;
 *   5. les postes (le tableau, `AdProItemsPanel tableau`) ;
 *   6. « Plus d'informations », replié : tout le reste, chaque partie avec son composant d'avant.
 *
 * On change l'INTERFACE, rien d'autre : chaque geste est le composant qui le portait déjà (panneau du circuit, clôture,
 * appel, déclaration, carte du poste), avec la même action. Des blocs d'affichage purs — aucun droit, aucune donnée lue
 * ici : la page les calcule. Sans « use client » : la page serveur les rend (aucun composant client ne l'importe).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** « SPO-2026-041 · demandé par Yacine B., délégué, le 12 novembre 2026 » — ce qu'on sait, sans trou. */
export function ligneDeLaDemande({ reference, par, role, le, suite }: {
  reference?: string | null;
  par?: string | null;
  role?: string | null;
  le?: Date | string | null;
  /** Ce qui s'ajoute en fin de ligne (« appel ×2 »). */
  suite?: string | null;
}): string {
  const qui = par ? `demandé par ${[par, role].filter(Boolean).join(", ")}` : null;
  const quand = le ? `le ${formatDate(le)}` : null;
  const demande = [qui, quand].filter(Boolean).join(qui && quand ? ", " : "");
  return [reference, demande || null, suite].filter(Boolean).join(" · ");
}

const BARRE: Record<EtapeBarre["etat"], { barre: string; titre: string }> = {
  fait: { barre: "bg-success", titre: "text-foreground" },
  en_cours: { barre: "bg-primary", titre: "font-semibold text-primary" },
  a_venir: { barre: "bg-border", titre: "text-muted-foreground" },
  refuse: { barre: "bg-destructive", titre: "text-destructive" },
};

const DIT: Record<EtapeBarre["etat"], string> = { fait: "faite", en_cours: "en cours", a_venir: "à venir", refuse: "refusée" };

/** « OÙ EN EST LA DEMANDE » — la barre d'étapes, sous l'en-tête. */
export function BarreEtapes({ etapes }: { etapes: EtapeBarre[] }) {
  return (
    <section aria-label="Où en est la demande" className="rounded-[var(--radius)] border border-border bg-card px-4 py-3.5 shadow-sm sm:px-5">
      <ol className="flex flex-col gap-2.5 sm:flex-row sm:gap-2">
        {etapes.map((e) => (
          <li
            key={e.cle} aria-current={e.etat === "en_cours" ? "step" : undefined}
            title={[e.titre, e.sousTitre, e.aide && e.aide !== e.sousTitre ? e.aide : null].filter(Boolean).join(" — ")}
            className="flex min-w-0 flex-1 flex-col gap-1"
          >
            <span aria-hidden className={cn("h-1.5 rounded-full", BARRE[e.etat].barre)} />
            <span className={cn("truncate text-[0.8125rem]", e.etat === "en_cours" ? "" : "font-medium", BARRE[e.etat].titre)}>
              {e.titre}<span className="sr-only"> — {DIT[e.etat]}</span>
            </span>
            <span className="truncate text-xs text-muted-foreground">{e.sousTitre || " "}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Un geste qui attend la personne qui regarde : ce qu'elle a à faire, et le composant qui le porte. */
export interface GesteAVous {
  cle: string;
  /** « prévalider la demande », « accorder le poste « Hébergement » »… — après « À vous : ». */
  titre: string;
  /** Une phrase de plus, quand il y a lieu. */
  phrase?: string | null;
  contenu: React.ReactNode;
}

/**
 * « À VOUS » — la carte bordée de bleu, montée seulement quand la personne qui regarde a un geste à faire maintenant. Le
 * premier geste fait le titre ; s'il y en a d'autres (rare : décider le circuit ET une déclaration), ils suivent, chacun
 * nommé.
 */
export function CarteAVous({ gestes }: { gestes: GesteAVous[] }) {
  if (gestes.length === 0) return null;
  const [premier, ...autres] = gestes;
  return (
    <section aria-labelledby="a-vous" className="space-y-3 rounded-[var(--radius)] border-2 border-primary bg-card px-4 py-4 shadow-sm sm:px-5">
      <div>
        <h2 id="a-vous" className="text-base font-semibold [overflow-wrap:anywhere]">À vous : {premier!.titre}</h2>
        {premier!.phrase && <p className="mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">{premier!.phrase}</p>}
      </div>
      <div>{premier!.contenu}</div>
      {autres.map((g) => (
        <div key={g.cle} className="space-y-2 border-t border-border pt-3">
          <h3 className="text-sm font-semibold [overflow-wrap:anywhere]">Aussi : {g.titre}</h3>
          {g.phrase && <p className="text-sm text-muted-foreground">{g.phrase}</p>}
          {g.contenu}
        </div>
      ))}
    </section>
  );
}

/** « LA DEMANDE » — quatre faits essentiels selon la nature, et la description. Le reste est dans « Plus d'informations ». */
export function CarteLaDemande({ faits, description, children }: {
  faits: { label: string; valeur: React.ReactNode }[];
  description?: string | null;
  children?: React.ReactNode;
}) {
  return (
    <section aria-labelledby="la-demande" className="space-y-3.5 rounded-[var(--radius)] border border-border bg-card px-4 py-4 shadow-sm sm:px-5">
      <h2 id="la-demande" className="text-base font-semibold">La demande</h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm lg:grid-cols-4">
        {faits.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{f.label}</dt>
            <dd className="font-medium [overflow-wrap:anywhere]">{f.valeur || "—"}</dd>
          </div>
        ))}
      </dl>
      {description && <p className="max-w-prose whitespace-pre-line text-sm text-muted-foreground [overflow-wrap:anywhere]">{description}</p>}
      {children}
    </section>
  );
}

/** Le cadre des postes : le tableau porte lui-même son titre (« Postes · N ») et ses boutons d'ajout. */
export function CartePostes({ children }: { children: React.ReactNode }) {
  return (
    <section id="postes" aria-label="Postes" className="scroll-mt-20 rounded-[var(--radius)] border border-border bg-card px-4 py-4 shadow-sm sm:px-5">
      {children}
    </section>
  );
}

/**
 * « PLUS D'INFORMATIONS » — replié par défaut : montants, médecins, pièces, discussion, équipe, circuit détaillé,
 * traçabilité. Un `<details>` natif (clavier, lecteurs d'écran), chaque partie une section repliable à son tour.
 */
export function PlusDInformations({ resume, children }: { resume?: string | null; children: React.ReactNode }) {
  return (
    <details id="plus-d-informations" className="group/plus scroll-mt-20 rounded-[var(--radius)] border border-border bg-card px-4 shadow-sm sm:px-5">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-3.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open/plus:rotate-90" aria-hidden />
        <span className="font-semibold">Plus d&apos;informations</span>
        {resume && <span className="ml-auto min-w-0 truncate pl-3 text-right text-xs text-muted-foreground group-open/plus:hidden">{resume}</span>}
      </summary>
      <div className="border-t border-border">{children}</div>
    </details>
  );
}

/**
 * « PIÈCES JOINTES » DANS « PLUS D'INFORMATIONS » — les pièces générales de la demande (le dépôt et la liste d'avant), puis
 * ce que la page y ajoute : les pièces Legal rattachées à la demande (`PiecesLegalDeLaDemande`).
 */
export function SectionPieces({ pieces, children }: { pieces: PiecesJointesDeLaDemande; children?: React.ReactNode }) {
  return (
    <SectionRepliable titre="Pièces jointes" compte={pieces.documents.length} sansCadre>
      <CarteDetailsDemande titre="Pièces de la demande" pieces={pieces} />
      {children}
    </SectionRepliable>
  );
}

/**
 * LA DÉCLARATION À SON ÉTAPE (information scientifique) : rien tant que `etapeDeclaration` la dit « à venir » — la barre la
 * montre grisée —, ni quand c'est à la personne qui regarde (elle est alors dans « À vous ») ; sinon une section, ouverte
 * sur un clic. La logique qui décide quand elle s'ouvre reste celle de `etapeDeclaration`.
 */
export function SectionDeclaration({ etape, children }: {
  etape: { titre: string; detail: string | null; etat: "done" | "current" | "todo"; aVous: boolean } | null;
  children: React.ReactNode;
}) {
  if (!etape || etape.etat === "todo" || etape.aVous) return null;
  return (
    <Sections>
      <SectionRepliable titre={etape.titre} resume={etape.detail ?? undefined}>{children}</SectionRepliable>
    </Sections>
  );
}
