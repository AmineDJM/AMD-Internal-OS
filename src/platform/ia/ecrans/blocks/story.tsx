"use client";

import * as React from "react";
import {
  Check, ChevronRight, CircleAlert, CircleDashed, Clock, FileText, Minus, Search, X,
} from "lucide-react";
import type {
  StoryEvent, StoryEventKind, WorkspaceBlock, WorkspaceMetric,
} from "@/platform/ia/workspace/protocol";
import { ActionRow, AskContext, Avatar, Card } from "../primitives";
import "../blocks-godmode.css";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA BUSINESS STORY — « retrace-moi l'AONIO 2023 ».
 *
 * ── CE QUE CE COMPOSANT DOIT RÉUSSIR, ET C'EST DIFFICILE ─────────────────────────────────
 *
 * Une affaire de marché public, c'est vingt à cinquante jalons sur deux ans. Les afficher à
 * plat produit un mur qu'on ne lit pas ; n'en montrer que cinq ment par omission. La solution
 * tenue ici :
 *
 *   • LES JALONS DE PREMIER RANG sont toujours visibles — publication, soumission, attribution,
 *     contrat, chaque bon de commande, clôture. C'est le récit.
 *   • LEURS ENFANTS (livraison, facture, paiement) sont REPLIÉS. Le zoom est un clic, pas une
 *     nouvelle requête : tout est déjà là.
 *   • LES FILS filtrent sans reconstruire — « seulement Nivolumab », « seulement les retards ».
 *
 * ── POURQUOI LES TROUS SONT AFFICHÉS ─────────────────────────────────────────────────────
 *
 * Un jalon `manque` (facture jamais émise, paiement jamais reçu) est dessiné, en creux. C'est
 * contre-intuitif — on montre ce qui n'existe pas — et c'est exactement la valeur : quand on
 * retrace une affaire, on cherche l'endroit où la chaîne s'est rompue.
 *
 * ── RESPONSIVE : LA FRISE CHANGE D'AXE, PAS DE NATURE ────────────────────────────────────
 *
 * Sur mobile la frise reste VERTICALE (elle l'est déjà) et les métriques passent sous le titre
 * au lieu d'être à droite. Aucun `overflow-x` : une frise qu'on fait défiler latéralement au
 * doigt est une frise qu'on ne lit pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type StoryBlock = Extract<WorkspaceBlock, { kind: "story" }>;

/** Le pictogramme d'un état — la forme dit l'état avant que la couleur ne le confirme. */
const ETAT_ICON = {
  fait: Check,
  "en-cours": Clock,
  "a-venir": CircleDashed,
  manque: Minus,
  echec: X,
} as const;

/** Le libellé court d'une nature de jalon, pour la puce de gauche. */
const KIND_LABEL: Record<StoryEventKind, string> = {
  publication: "AO",
  "cahier-des-charges": "CDC",
  soumission: "Soumission",
  attribution: "Attribution",
  contrat: "Contrat",
  avenant: "Avenant",
  commande: "Commande",
  livraison: "Livraison",
  facture: "Facture",
  paiement: "Paiement",
  courrier: "Courrier",
  decision: "Décision",
  jalon: "Jalon",
  cloture: "Clôture",
  incident: "Incident",
};

/** « 28 mars 2023 » — la date longue, parce qu'une frise se lit et ne se calcule pas. */
function dateLongue(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

function Metriques({ items }: { items: WorkspaceMetric[] }) {
  if (!items.length) return null;
  return (
    <ul className="chief-story-metrics">
      {items.map((m, i) => (
        <li key={i} className="chief-story-metric" data-ton={m.ton ?? "neutre"}>
          <span className="chief-story-metric-value">{m.valeur}</span>
          <span className="chief-story-metric-label">{m.label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * UN JALON. La ligne de vie à gauche, le contenu à droite.
 *
 * `dernier` supprime le segment de ligne sous la puce : une frise dont le trait dépasse du
 * dernier jalon suggère une suite qui n'existe pas.
 */
function Jalon({
  e, enfants, dernier, profondeur, ouvert, onToggle, marque,
}: {
  e: StoryEvent;
  enfants: StoryEvent[];
  dernier: boolean;
  profondeur: number;
  ouvert: boolean;
  onToggle: () => void;
  marque: string;
}) {
  const ask = React.useContext(AskContext);
  const Icon = ETAT_ICON[e.etat];
  const date = dateLongue(e.date);
  const pliable = enfants.length > 0;

  // LA MISE EN VALEUR DE LA RECHERCHE. Volontairement une classe, pas une réécriture du texte :
  // surligner en découpant la chaîne casserait les accents composés et les espaces insécables.
  const trouve = marque.length >= 2
    && `${e.titre} ${e.detail ?? ""} ${KIND_LABEL[e.kind]}`.toLowerCase().includes(marque.toLowerCase());

  return (
    <li
      className="chief-story-event"
      data-etat={e.etat}
      data-kind={e.kind}
      data-depth={profondeur}
      data-certitude={e.certitude ?? "fait"}
      data-found={trouve || undefined}
      data-testid="story-event"
    >
      <div className="chief-story-rail" aria-hidden>
        <span className="chief-story-dot" data-etat={e.etat}>
          <Icon className="chief-story-dot-icon" />
        </span>
        {dernier ? null : <span className="chief-story-line" />}
      </div>

      <div className="chief-story-body">
        <div className="chief-story-head">
          <span className="chief-story-kind">{KIND_LABEL[e.kind]}</span>
          {date ? <time className="chief-story-date" dateTime={e.date ?? undefined}>{date}</time> : null}
          {e.retardJours && e.retardJours > 0 ? (
            <span className="chief-story-late" title="Écart avec la date attendue">
              <CircleAlert className="h-3 w-3" aria-hidden /> +{e.retardJours} j
            </span>
          ) : null}
        </div>

        <div className="chief-story-title-row">
          {pliable ? (
            <button
              type="button"
              className="chief-story-toggle"
              onClick={onToggle}
              aria-expanded={ouvert}
              data-testid="story-toggle"
            >
              <ChevronRight className={`h-3.5 w-3.5 chief-story-chevron${ouvert ? " is-open" : ""}`} aria-hidden />
              <span className="chief-story-title">{e.titre}</span>
              <span className="chief-story-count">{enfants.length}</span>
            </button>
          ) : (
            <span className="chief-story-title">{e.titre}</span>
          )}
        </div>

        {e.detail ? <p className="chief-story-detail">{e.detail}</p> : null}
        {e.metriques?.length ? <Metriques items={e.metriques} /> : null}

        {e.participants?.length ? (
          <ul className="chief-story-people">
            {e.participants.slice(0, 4).map((p, i) => (
              <li key={i} className="chief-story-person" title={p.role ? `${p.nom} — ${p.role}` : p.nom}>
                <Avatar nom={p.nom} photo={p.photo} taille="s" />
                <span>{p.nom}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {/* LES PIÈCES, DANS LE JALON. « Montre les documents » ne doit pas déplacer le regard
            ailleurs : le contrat se lit sous le jalon « contrat signé », pas dans un tiroir. */}
        {e.docs?.length ? (
          <ul className="chief-story-docs">
            {e.docs.slice(0, 3).map((d, i) => (
              <li key={i}>
                <a className="chief-story-doc" href={d.href} target="_blank" rel="noreferrer">
                  <FileText className="h-3.5 w-3.5" aria-hidden />
                  <span className="chief-story-doc-name">{d.nom}</span>
                  {d.taille ? <span className="chief-story-doc-size">{d.taille}</span> : null}
                </a>
              </li>
            ))}
          </ul>
        ) : null}

        {/* LA PROVENANCE, DISCRÈTE (§51). Elle ne s'affiche qu'au survol sur grand écran :
            elle doit être VÉRIFIABLE, pas omniprésente. */}
        {e.provenance ? <span className="chief-story-source">{e.provenance}</span> : null}

        {e.actions?.length && ask ? <ActionRow actions={e.actions} /> : null}

        {pliable && ouvert ? (
          <ol className="chief-story-children" data-testid="story-children">
            {enfants.map((c, i) => (
              <Jalon
                key={c.id}
                e={c}
                enfants={[]}
                dernier={i === enfants.length - 1}
                profondeur={profondeur + 1}
                ouvert={false}
                onToggle={() => {}}
                marque={marque}
              />
            ))}
          </ol>
        ) : null}
      </div>
    </li>
  );
}

export function StoryBlock({ b }: { b: StoryBlock }) {
  // LE FIL ACTIF. `null` = tout. Un seul à la fois : deux filtres combinés produisent des
  // intersections vides qu'on ne sait pas expliquer à l'écran.
  const [fil, setFil] = React.useState<string | null>(null);
  /**
   * CE QUI EST OUVERT D'EMBLÉE — et la faute que la capture d'écran a révélée.
   *
   * Premier essai : tout replié. C'est propre, et c'est faux. Les deux jalons MANQUANTS de la
   * frise — la facture jamais émise, le paiement jamais reçu — étaient des enfants du bon de
   * commande, donc invisibles tant qu'on ne dépliait pas. La story annonçait « 2 jalons
   * manquants » en tête et n'en montrait aucun : exactement l'histoire sans son trou que §46
   * interdit. Le test de la planche l'a fait tomber ; la capture l'a rendu évident.
   *
   * La règle tenue depuis : un jalon dont un enfant MANQUE ou a ÉCHOUÉ s'ouvre tout seul. Ce
   * qui va bien reste replié — c'est l'anomalie qui mérite la place, pas le nominal.
   */
  const [ouverts, setOuverts] = React.useState<Set<string>>(() => {
    const n = new Set<string>();
    for (const e of b.events) {
      if ((e.etat === "manque" || e.etat === "echec") && e.parent) n.add(e.parent);
    }
    return n;
  });
  const [q, setQ] = React.useState("");

  const parId = React.useMemo(() => new Map(b.events.map((e) => [e.id, e])), [b.events]);

  /**
   * LE FILTRAGE EST UNE LECTURE, PAS UNE RECONSTRUCTION (§49).
   *
   * Un enfant retenu FAIT REMONTER son parent, même si le parent n'appartient pas au fil : sans
   * cela, filtrer sur « paiements » afficherait des paiements orphelins, sans le bon de commande
   * qui leur donne un sens.
   */
  const { racines, enfantsDe } = React.useMemo(() => {
    const garde = (e: StoryEvent): boolean => {
      if (!fil) return true;
      if ((e.fils ?? []).includes(fil)) return true;
      // Un parent est gardé si l'un de ses enfants l'est.
      return b.events.some((c) => c.parent === e.id && (c.fils ?? []).includes(fil));
    };
    const retenus = b.events.filter(garde);
    const enfants = new Map<string, StoryEvent[]>();
    const rac: StoryEvent[] = [];
    for (const e of retenus) {
      if (e.parent && parId.has(e.parent)) {
        const l = enfants.get(e.parent) ?? [];
        l.push(e);
        enfants.set(e.parent, l);
      } else {
        rac.push(e);
      }
    }
    return { racines: rac, enfantsDe: enfants };
  }, [b.events, fil, parId]);

  const nTrouves = React.useMemo(() => {
    if (q.trim().length < 2) return null;
    const t = q.trim().toLowerCase();
    return b.events.filter((e) => `${e.titre} ${e.detail ?? ""}`.toLowerCase().includes(t)).length;
  }, [b.events, q]);

  const toggle = (id: string) =>
    setOuverts((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  const tousOuverts = ouverts.size > 0 && racines.every((r) => !enfantsDe.get(r.id)?.length || ouverts.has(r.id));

  return (
    <Card title={b.title} meta={b.subtitle ?? undefined} actions={b.actions}>
      {b.kpis?.length ? (
        <ul className="chief-story-kpis" data-testid="story-kpis">
          {b.kpis.map((k, i) => (
            <li key={i} className="chief-story-kpi" data-ton={k.ton ?? "neutre"}>
              <span className="chief-story-kpi-value">{k.valeur}</span>
              <span className="chief-story-kpi-label">{k.label}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* ── LA BARRE DE LECTURE : fils, recherche, tout replier. ──────────────────────── */}
      {(b.threads?.length ?? 0) > 0 || b.events.length > 6 ? (
        <div className="chief-story-bar">
          {b.threads?.length ? (
            <div className="chief-story-threads" role="group" aria-label="Filtrer la frise">
              <button
                type="button"
                className={`chief-story-thread${fil === null ? " is-on" : ""}`}
                onClick={() => setFil(null)}
                data-testid="story-thread-all"
              >
                Tout <span className="chief-story-thread-n">{b.events.length}</span>
              </button>
              {b.threads.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`chief-story-thread${fil === t.id ? " is-on" : ""}`}
                  data-genre={t.genre ?? "famille"}
                  onClick={() => setFil(fil === t.id ? null : t.id)}
                  data-testid="story-thread"
                >
                  {t.label} <span className="chief-story-thread-n">{t.count}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="chief-story-tools">
            {b.events.length > 10 ? (
              <label className="chief-story-search">
                <Search className="h-3.5 w-3.5" aria-hidden />
                <input
                  type="search"
                  value={q}
                  onChange={(ev) => setQ(ev.target.value)}
                  placeholder="Chercher dans la frise…"
                  aria-label="Chercher dans la frise"
                  data-testid="story-search"
                />
                {/* UNE RECHERCHE SANS RÉSULTAT DOIT LE DIRE (§54). La première version n'affichait
                    qu'un « 0 » de la taille d'une pastille : on ne savait pas si le jalon
                    n'existait pas ou si on avait raté le surlignage. */}
                {nTrouves !== null ? (
                  <span className="chief-story-found" data-vide={nTrouves === 0 || undefined}>
                    {nTrouves === 0 ? "aucun" : nTrouves}
                  </span>
                ) : null}
              </label>
            ) : null}
            {racines.some((r) => (enfantsDe.get(r.id)?.length ?? 0) > 0) ? (
              <button
                type="button"
                className="chief-story-expand"
                onClick={() => setOuverts(tousOuverts ? new Set() : new Set(racines.map((r) => r.id)))}
                data-testid="story-expand-all"
              >
                {tousOuverts ? "Tout replier" : "Tout déplier"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <ol className="chief-story" data-testid="story-timeline">
        {racines.map((e, i) => (
          <Jalon
            key={e.id}
            e={e}
            enfants={enfantsDe.get(e.id) ?? []}
            dernier={i === racines.length - 1}
            profondeur={0}
            ouvert={ouverts.has(e.id)}
            onToggle={() => toggle(e.id)}
            marque={q.trim()}
          />
        ))}
      </ol>

      {racines.length === 0 ? (
        <p className="chief-block-empty" data-testid="story-empty">
          Aucun jalon pour ce fil.
        </p>
      ) : null}

      {/* ── CE QUE LA RECONSTITUTION N'A PAS VU. Une story sans limites se croit complète. ── */}
      {b.limites?.length ? (
        <ul className="chief-story-limits" data-testid="story-limits">
          {b.limites.map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      ) : null}
    </Card>
  );
}
