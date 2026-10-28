"use client";

import * as React from "react";
import { AlertTriangle, ArrowRight, Check, CircleAlert, Info, Loader2, X } from "lucide-react";
import type { WorkspaceBlock } from "@/lib/assistant/workspace/protocol";
import { ActionRow, AskContext, Card } from "../primitives";
import "../blocks-godmode.css";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * COMPARAISON · MISSION · ALERTE — trois blocs qui partagent une exigence : DIRE CE QUI EST.
 *
 * Ils sont réunis ici parce qu'ils sont courts et de même famille — des objets de DÉCISION, par
 * opposition aux vues (story, 360) qui sont des objets de LECTURE. Les séparer en trois fichiers
 * de soixante lignes n'aurait ajouté que des imports.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Comparison = Extract<WorkspaceBlock, { kind: "comparison" }>;
type Mission = Extract<WorkspaceBlock, { kind: "mission" }>;
type Alerte = Extract<WorkspaceBlock, { kind: "alerte" }>;

/**
 * LA COMPARAISON — et pourquoi `delta` et `insight` sont DEUX colonnes.
 *
 * Le delta est arithmétique et vérifiable ; l'insight est une lecture. Les fondre ferait passer
 * un commentaire pour un calcul, ce qui est précisément l'erreur qu'un tableau de comparaison
 * doit empêcher.
 *
 * MOBILE : le tableau devient une LISTE de dimensions, chacune avec ses valeurs empilées. Pas
 * de défilement latéral — une comparaison qu'on fait glisser n'est plus une comparaison, on ne
 * voit jamais les deux colonnes ensemble.
 */
export function ComparisonBlock({ b }: { b: Comparison }) {
  return (
    <Card title={b.title} meta={b.subtitle ?? undefined} actions={b.actions}>
      <div className="chief-cmp" data-testid="comparison">
        <div className="chief-cmp-head" role="row">
          <span className="chief-cmp-dim" />
          {b.sujets.map((s) => (
            <span key={s.id} className="chief-cmp-subject">
              <span className="chief-cmp-subject-label">{s.label}</span>
              {s.sousTitre ? <span className="chief-cmp-subject-sub">{s.sousTitre}</span> : null}
            </span>
          ))}
          <span className="chief-cmp-delta-head">Écart</span>
        </div>

        {b.lignes.map((l, i) => (
          <div key={i} className="chief-cmp-row" data-testid="comparison-row">
            <span className="chief-cmp-dim">{l.dimension}</span>
            {b.sujets.map((s, j) => (
              <span key={s.id} className="chief-cmp-cell" data-label={s.label}>
                {l.valeurs[j] ?? "—"}
              </span>
            ))}
            <span className="chief-cmp-delta" data-ton={l.deltaTon ?? "neutre"}>
              {l.delta ?? "—"}
            </span>
            {l.insight ? (
              <span className="chief-cmp-insight">
                <Info className="h-3 w-3 shrink-0" aria-hidden /> {l.insight}
              </span>
            ) : null}
          </div>
        ))}
      </div>
      {b.note ? <p className="chief-block-note">{b.note}</p> : null}
    </Card>
  );
}

const ETAPE_ICON = {
  "a-faire": ArrowRight,
  "en-cours": Loader2,
  fait: Check,
  echec: X,
  ignore: CircleAlert,
} as const;

/**
 * LA MISSION — plusieurs gestes, UNE confirmation (§18).
 *
 * Le point décisif est que la carte NE SE DUPLIQUE PAS : la même mission traverse « à
 * confirmer » puis « exécutée », en changeant ses étapes. Une seconde carte de résultat
 * laisserait deux objets dans le fil dont on ne saurait plus lequel fait foi.
 */
export function MissionBlock({ b }: { b: Mission }) {
  const ask = React.useContext(AskContext);
  const restantes = b.etapes.filter((e) => e.etat === "a-faire" || e.etat === "en-cours").length;
  const echouees = b.etapes.filter((e) => e.etat === "echec").length;

  return (
    <Card title={b.title} meta={b.subtitle ?? undefined} actions={b.actions}>
      {/* ── L'HORIZON D'ABORD (§118.50) ────────────────────────────────────────────────
          Sur une mission longue, les étapes qui suivent sont celles du jalon COURANT — les
          jalons suivants n'ont pas encore d'étapes, par construction. Montrer les étapes
          seules ferait lire « 4/5 », donc « presque fini », sur une mission qui a six semaines
          devant elle. Absent d'une mission courte, et c'est la bonne réponse. */}
      {b.jalons?.length ? (
        <ol className="chief-mission" data-testid="mission-jalons">
          {b.jalons.map((j) => {
            const Icon = ETAPE_ICON[j.etat];
            return (
              <li key={j.ordre} className="chief-mission-step" data-etat={j.etat} data-testid="mission-jalon">
                <Icon className={`chief-mission-icon${j.etat === "en-cours" ? " chief-mission-spin" : ""}`} aria-hidden />
                <div className="chief-mission-body">
                  <span className="chief-mission-label">{j.ordre}. {j.titre}</span>
                  {/* LE RÉSULTAT ATTENDU, pas le titre : c'est lui que le contrôle de fin
                      comparera au réel. */}
                  {j.resultat ? <span className="chief-mission-detail">{j.resultat}</span> : null}
                  {j.compile === false ? (
                    <span className="chief-mission-detail">pas encore de sous-plan — ce jalon n&apos;existe que comme intention</span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}

      <ol className="chief-mission" data-testid="mission">
        {b.etapes.map((e) => {
          const Icon = ETAPE_ICON[e.etat];
          return (
            <li key={e.id} className="chief-mission-step" data-etat={e.etat} data-testid="mission-step">
              <Icon className={`chief-mission-icon${e.etat === "en-cours" ? " chief-mission-spin" : ""}`} aria-hidden />
              <div className="chief-mission-body">
                <span className="chief-mission-label">{e.label}</span>
                {e.detail ? <span className="chief-mission-detail">{e.detail}</span> : null}
                {/* UNE ERREUR ACTIONNABLE (§53). « Adresse rejetée », pas « erreur 400 » — le
                    message doit dire quoi FAIRE, sinon il ne sert qu'à inquiéter. */}
                {e.erreur ? (
                  <span className="chief-mission-error">
                    <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden /> {e.erreur}
                  </span>
                ) : null}
                {/* LE GESTE QUI RÉPARE, sous l'erreur qu'il répare. Ailleurs, il faudrait
                    d'abord retrouver de quelle étape on parle. */}
                {e.actions?.length && ask ? <ActionRow actions={e.actions} /> : null}
              </div>
            </li>
          );
        })}
      </ol>

      {b.confirmation && ask ? (
        <div className="chief-mission-confirm" data-testid="mission-confirm">
          <ActionRow actions={[b.confirmation]} />
          <span className="chief-mission-hint">
            {restantes} action{restantes > 1 ? "s" : ""} — une seule confirmation.
          </span>
        </div>
      ) : null}

      {!b.confirmation && echouees === 0 && restantes === 0 ? (
        <p className="chief-mission-done" data-testid="mission-done">Mission exécutée.</p>
      ) : null}
    </Card>
  );
}

const ALERTE_ICON = { info: Info, attention: CircleAlert, alerte: AlertTriangle } as const;

/**
 * L'ALERTE PROACTIVE (§20) — Adam parle sans qu'on lui ait rien demandé.
 *
 * Elle vit dans le MÊME fil : une notification qui ouvre un autre écran oblige à reconstruire
 * le contexte qu'on avait déjà sous les yeux. Et elle porte TOUJOURS une issue — « corriger »,
 * « renvoyer » : une alerte sans action est une inquiétude, pas une information.
 */
export function AlerteBlock({ b }: { b: Alerte }) {
  const Icon = ALERTE_ICON[b.ton];
  return (
    <section className="chief-alerte" data-ton={b.ton} data-testid="alerte" role="status">
      <Icon className="chief-alerte-icon" aria-hidden />
      <div className="chief-alerte-body">
        <h3 className="chief-alerte-title">{b.title}</h3>
        <p className="chief-alerte-message">{b.message}</p>
        {b.detail ? <p className="chief-alerte-detail">{b.detail}</p> : null}
        {b.origine ? <span className="chief-alerte-origin">{b.origine}</span> : null}
        {b.actions?.length ? <ActionRow actions={b.actions} /> : null}
      </div>
    </section>
  );
}
