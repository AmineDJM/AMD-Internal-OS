"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight, ExternalLink, FileText, Info } from "lucide-react";
import type { WorkspaceBlock, WorkspaceField, WorkspaceGauge, WorkspaceMetric } from "@/platform/ia/workspace/protocol";
import { ActionRow, AskContext, Avatar, Card, Chip } from "../primitives";
import "../blocks-godmode.css";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VUE 360 — produit, marché, contrat, personne, avec DIVULGATION PROGRESSIVE.
 *
 * ── LE PIÈGE QU'ELLE ÉVITE ───────────────────────────────────────────────────────────────
 *
 * « Analyse-moi Nivolumab » peut légitimement produire cinquante indicateurs : réglementaire,
 * marchés, ventes, force de vente, Ad&Pro, finance, terrain. Les afficher ensemble ne fait pas
 * une vue 360 — ça fait un tableau de bord, c'est-à-dire l'objet que ce produit refuse d'être,
 * et qu'on ne lit pas.
 *
 * La règle tenue ici : QUATRE KPI EN TÊTE, DEUX SECTIONS OUVERTES, le reste replié. Le serveur
 * décide lesquelles avec `ouvert`, parce que lui seul sait ce qui est anormal sur CE produit —
 * une section « finance » ouverte parce que la créance est élevée vaut mieux qu'un ordre fixe.
 *
 * ── UN SEUL COMPOSANT POUR QUATRE ENTITÉS ────────────────────────────────────────────────
 *
 * Produit, marché, contrat et personne ont la même FORME : en-tête, chiffres, sections. Quatre
 * composants identiques auraient produit quatre fichiers à maintenir en parallèle, donc trois
 * qui divergent. Ce qui les distingue est dans les DONNÉES, pas dans le rendu.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Entity360 = Extract<WorkspaceBlock, { kind: "entity360" }>;
type Section = Entity360["sections"][number];

function Kpis({ items }: { items: WorkspaceMetric[] }) {
  return (
    <ul className="chief-e360-kpis" data-testid="e360-kpis">
      {items.map((k, i) => (
        <li key={i} className="chief-e360-kpi" data-ton={k.ton ?? "neutre"}>
          <span className="chief-e360-kpi-value">{k.valeur}</span>
          <span className="chief-e360-kpi-label">{k.label}</span>
        </li>
      ))}
    </ul>
  );
}

function Champs({ fields }: { fields: WorkspaceField[] }) {
  return (
    <dl className="chief-e360-fields">
      {fields.map((f, i) => (
        <div key={i} className="chief-e360-field">
          <dt>{f.label}</dt>
          <dd data-ton={f.ton ?? "neutre"}>
            {f.avatar ? (
              <span className="chief-e360-value-person">
                <Avatar nom={f.avatar.nom} photo={f.avatar.photo} taille="s" />
                {f.value}
              </span>
            ) : f.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Jauges({ gauges }: { gauges: WorkspaceGauge[] }) {
  return (
    <ul className="chief-e360-gauges">
      {gauges.map((g, i) => {
        const pct = g.total && g.total > 0
          ? Math.min(100, Math.round((g.valeur / g.total) * 100))
          : Math.min(100, Math.round(g.valeur));
        return (
          <li key={i} className="chief-e360-gauge" data-ton={g.ton ?? "neutre"}>
            <div className="chief-e360-gauge-head">
              <span>{g.label}</span>
              <span className="chief-e360-gauge-detail">
                {g.detail ?? (g.total ? `${g.valeur} / ${g.total}${g.unite ? ` ${g.unite}` : ""}` : `${pct} %`)}
              </span>
            </div>
            <div className="chief-e360-gauge-track">
              <span className="chief-e360-gauge-fill" style={{ width: `${pct}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Une section repliable. Ouverte d'emblée seulement si le SERVEUR l'a décidé. */
function SectionView({ s }: { s: Section }) {
  const [open, setOpen] = React.useState(Boolean(s.ouvert));
  const ask = React.useContext(AskContext);

  const vide = !s.fields?.length && !s.gauges?.length && !s.items?.length
    && !s.table?.rows.length && !s.docs?.length && !s.people?.length;

  return (
    <section className="chief-e360-section" data-open={open} data-testid="e360-section">
      <button
        type="button"
        className="chief-e360-section-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="e360-section-toggle"
      >
        <ChevronRight className={`h-3.5 w-3.5 chief-e360-chevron${open ? " is-open" : ""}`} aria-hidden />
        <span className="chief-e360-section-label">{s.label}</span>
      </button>

      {open ? (
        <div className="chief-e360-section-body">
          {/* UN ÉTAT VIDE RESTE UTILE (§54) : il dit ce qui manque et ce qu'on peut y faire,
              au lieu de laisser un blanc qu'on prend pour un bug. */}
          {vide ? (
            <p className="chief-block-empty">{s.note ?? "Rien à afficher dans cette section."}</p>
          ) : null}

          {s.fields?.length ? <Champs fields={s.fields} /> : null}
          {s.gauges?.length ? <Jauges gauges={s.gauges} /> : null}

          {s.people?.length ? (
            <ul className="chief-e360-people">
              {s.people.map((p, i) => (
                <li key={i} className="chief-e360-person">
                  <Avatar nom={p.nom} photo={p.photo} taille="s" />
                  <span className="chief-e360-person-name">{p.nom}</span>
                  {p.poste ? <span className="chief-e360-person-role">{p.poste}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}

          {s.items?.length ? (
            <ul className="chief-e360-items">
              {s.items.map((it, i) => (
                <li key={i} className="chief-e360-item">
                  <div className="chief-e360-item-main">
                    <span className="chief-e360-item-title">{it.titre}</span>
                    {it.detail ? <span className="chief-e360-item-detail">{it.detail}</span> : null}
                  </div>
                  {it.statut ? <Chip label={it.statut} /> : null}
                  {it.echeance ? <span className="chief-e360-item-due">{it.echeance}</span> : null}
                  {it.actions?.length && ask ? <ActionRow actions={it.actions} /> : null}
                </li>
              ))}
            </ul>
          ) : null}

          {s.table?.rows.length ? (
            <div className="chief-e360-table-wrap">
              <table className="chief-e360-table">
                <thead>
                  <tr>{s.table.columns.map((c) => <th key={c.key} data-num={c.numeric || undefined}>{c.label}</th>)}</tr>
                </thead>
                <tbody>
                  {s.table.rows.map((r, i) => (
                    <tr key={i}>
                      {s.table!.columns.map((c) => (
                        <td key={c.key} data-num={c.numeric || undefined} data-ton={r.tons?.[c.key] ?? undefined}>
                          {r.cells[c.key] ?? "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {s.table.total && s.table.total > s.table.rows.length ? (
                <p className="chief-block-note">{s.table.total - s.table.rows.length} ligne(s) de plus sur l'écran métier.</p>
              ) : null}
            </div>
          ) : null}

          {s.docs?.length ? (
            <ul className="chief-e360-docs">
              {s.docs.map((d, i) => (
                <li key={i}>
                  <a className="chief-e360-doc" href={d.href} target="_blank" rel="noreferrer">
                    <FileText className="h-3.5 w-3.5" aria-hidden />
                    <span>{d.nom}</span>
                    {d.taille ? <span className="chief-e360-doc-size">{d.taille}</span> : null}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}

          {!vide && s.note ? <p className="chief-block-note">{s.note}</p> : null}
          {s.actions?.length && ask ? <ActionRow actions={s.actions} /> : null}
        </div>
      ) : null}
    </section>
  );
}

export function Entity360Block({ b }: { b: Entity360 }) {
  return (
    <Card title={b.title} actions={b.actions} hideHead>
      <header className="chief-e360-head">
        {b.photo ? <Avatar nom={b.title} photo={b.photo} taille="l" /> : null}
        <div className="chief-e360-ident">
          <h3 className="chief-e360-title" data-testid="e360-title">{b.title}</h3>
          <div className="chief-e360-sub">
            {b.subtitle ? <span>{b.subtitle}</span> : null}
            {b.badges?.map((bd, i) => <Chip key={i} label={bd.label} ton={bd.ton} />)}
          </div>
        </div>
        {b.href ? (
          <Link href={b.href} className="chief-e360-link" title="Ouvrir l'écran métier">
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </Link>
        ) : null}
      </header>

      {b.kpis?.length ? <Kpis items={b.kpis} /> : null}

      <div className="chief-e360-sections">
        {b.sections.map((s) => <SectionView key={s.id} s={s} />)}
      </div>

      {/* CE QUI N'A PAS PU ÊTRE CALCULÉ, DIT. Un « 0 » sans explication se lit comme un fait. */}
      {b.limites?.length ? (
        <ul className="chief-e360-limits" data-testid="e360-limits">
          {b.limites.map((l, i) => (
            <li key={i}><Info className="h-3 w-3 shrink-0" aria-hidden /> {l}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
