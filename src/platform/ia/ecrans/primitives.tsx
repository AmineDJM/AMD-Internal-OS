"use client";

import * as React from "react";
import {
  Eye, Mail, CheckSquare, Pencil, ScanLine, Send, CircleAlert, CalendarClock, BellRing, Check,
} from "lucide-react";
import type { WorkspaceAction, WorkspaceActionIcon, WorkspaceActionIntent } from "@/platform/ia/workspace/protocol";
import "./blocks.css";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PRIMITIVES PARTAGÉES DE L'ESPACE DE TRAVAIL.
 *
 * Extraites de `blocks.tsx`, qui atteignait 1 100 lignes et portait à la fois les primitives et
 * les treize rendus. Le déclencheur n'est pas la longueur : c'est que les nouveaux blocs riches
 * (story, vue 360, comparaison, mission) avaient besoin de la carte, du bouton et de la
 * pastille. Les laisser dans `blocks.tsx` aurait imposé un import CIRCULAIRE — `blocks.tsx`
 * important les nouveaux blocs, et les nouveaux blocs important `blocks.tsx`.
 *
 * Ce fichier ne connaît donc AUCUN type de bloc. Il ne sait que dessiner une carte, un bouton,
 * une pastille, un visage — ce qui est exactement ce qui doit être partagé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */


/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * COMMENT UN BOUTON DE CET ESPACE AGIT — et pourquoi il ne fait qu'écrire.
 *
 * Un bloc peut proposer un geste (« Approuver », « Refuser »). Le clic n'exécute RIEN ici : il
 * envoie dans la conversation la phrase que le SERVEUR a rédigée, avec la référence exacte,
 * exactement comme si le PDG l'avait tapée. La mutation emprunte donc la porte unique —
 * proposition, carte de confirmation, action canonique, RBAC revérifié, audit.
 *
 * Le contexte existe parce que ces blocs s'affichent à deux endroits (le bureau d'Adam et la
 * page Assistant) : faire descendre un `onAsk` à travers chaque rendu polluerait huit signatures
 * pour une capacité que deux blocs utilisent. Sans fournisseur, les gestes ne s'affichent pas —
 * un bouton mort serait pire que pas de bouton.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export type AskFn = (phrase: string, intent?: WorkspaceActionIntent) => void;

export const AskContext = React.createContext<AskFn | null>(null);

export function WorkspaceAskProvider(
  { ask, children }: { ask: AskFn; children: React.ReactNode },
) {
  return <AskContext.Provider value={ask}>{children}</AskContext.Provider>;
}

/**
 * LE PICTOGRAMME D'UN GESTE. Une rangée de quatre boutons gris se relit mot à mot ; les mêmes
 * avec une forme se reconnaissent avant d'être lus. Le vocabulaire est fermé côté protocole,
 * donc ce tableau est exhaustif par construction — une icône inconnue n'existe pas.
 */
const ACTION_ICON: Record<WorkspaceActionIcon, React.ComponentType<{ className?: string }>> = {
  voir: Eye,
  email: Mail,
  tache: CheckSquare,
  modifier: Pencil,
  apercu: ScanLine,
  envoyer: Send,
  escalade: CircleAlert,
  planifier: CalendarClock,
  relancer: BellRing,
  valider: Check,
};

export function ActionRow({ actions, footer = false }: { actions: WorkspaceAction[]; footer?: boolean }) {
  const ask = React.useContext(AskContext);
  // Un tour est en cours dès qu'on a cliqué : re-cliquer enverrait la phrase deux fois, et
  // « Approuve VAL-014 » posée deux fois est une seconde décision, pas un doublon inoffensif.
  const [sent, setSent] = React.useState<string | null>(null);
  // SANS FOURNISSEUR, RIEN — pas même le filet de séparation. Un pied de carte vide sous un
  // objet promet des gestes qui n'existent pas ; c'est le test de rendu qui l'a montré.
  if (!ask) return null;
  return (
    <div className={footer ? "chief-actions chief-block-actions" : "chief-actions"}>
      {actions.map((a) => {
        const Icon = a.icone ? ACTION_ICON[a.icone] : null;
        return (
          <button
            key={a.phrase}
            type="button"
            className={`chief-action${a.ton === "danger" ? " chief-action-danger" : a.ton === "primaire" ? " chief-action-primary" : ""}`}
            disabled={sent !== null}
            // L'INTENTION D'ABORD, QUAND ELLE EXISTE (§23) : le serveur savait déjà quelle
            // lecture faire, on ne la fait pas redécouvrir par un modèle. Sinon la phrase —
            // qui reste le chemin de toutes les mutations.
            onClick={() => { setSent(a.phrase); ask(a.phrase, a.intent); }}
            title={a.phrase}
          >
            {Icon ? <Icon className="chief-action-icon" /> : null}
            {sent === a.phrase ? "Envoyé…" : a.libelle}
          </button>
        );
      })}
    </div>
  );
}

// ── Primitives partagées ──────────────────────────────────────────────────────────────────

export function Card(
  { title, meta, children, actions, hideHead }:
  { title: string; meta?: React.ReactNode; children: React.ReactNode; actions?: WorkspaceAction[]; hideHead?: boolean },
) {
  return (
    <section className="chief-block">
      {hideHead ? null : (
        <header className="chief-block-head">
          <h3 className="chief-block-title">{title}</h3>
          {meta ? <span className="chief-block-meta">{meta}</span> : null}
        </header>
      )}
      {children}
      {/* LES ACTIONS APPARTIENNENT À L'OBJET, VISUELLEMENT. Posées en pied de carte, elles se
          lisent comme « ce que je peux faire de CECI » — et non comme une barre d'outils
          flottante dont on se demande sur quoi elle agit. */}
      {actions?.length ? <ActionRow actions={actions} footer /> : null}
    </section>
  );
}

/** Une pastille sémantique : le ton porte l'information, pas la décoration. */
export function Chip({ label, ton }: { label: string; ton?: "neutre" | "succes" | "attention" | "alerte" }) {
  return <span className={`chief-chip${ton && ton !== "neutre" ? ` chief-chip-${ton}` : ""}`}>{label}</span>;
}

/**
 * LE VISAGE, OU LES INITIALES — et jamais un trou.
 *
 * C'est le point important : la mise en page ne doit pas sauter selon qu'un visage existe ou
 * non, sinon la même carte se lit différemment d'une personne à l'autre.
 *
 * `taille` porte l'échelle métier, pas des pixels : la fiche d'une personne mérite un grand
 * portrait, une ligne de participants n'en a pas besoin.
 */
export function Avatar(
  { nom, photo, taille = "m" }: { nom: string; photo?: string | null; taille?: "s" | "m" | "l" },
) {
  const [ko, setKo] = React.useState(false);
  const letters = nom.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
  const cls = `chief-avatar chief-avatar-${taille}`;
  if (photo && !ko) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- route ERP dynamique, pas un asset
      <img
        src={photo}
        alt=""
        aria-hidden
        className={`${cls} chief-avatar-photo`}
        onError={() => setKo(true)}
        loading="lazy"
      />
    );
  }
  return <span className={cls} aria-hidden>{letters || "?"}</span>;
}

