"use client";

import * as React from "react";
import Link from "next/link";
import { Mail, Pencil, Check, Phone, MessageCircle } from "lucide-react";
import type { WorkspaceBlock, WorkspaceComposition, WorkspaceDoc, WorkspaceEndpoint, WorkspaceField, WorkspaceGauge, WorkspacePerson, WorkspaceStep } from "@/platform/ia/workspace/protocol";
// La feuille voyage AVEC le composant : les blocs s'affichent aussi dans la page Assistant de
// l'ERP, qui ne charge pas `chief.css`. Elle porte ses propres valeurs de repli.
// L'ENCLOS ANTI-INJECTION EST POUR LE MODÈLE, PAS POUR L'ŒIL : le déballeur vit dans le
// module qui pose le marqueur — module PUR, zéro import, sans danger pour le bundle client.
import { deballerUntrusted } from "@/lib/comms/untrusted";
import "./blocks.css";
import { ActionRow, AskContext, Avatar, Card, Chip, WorkspaceAskProvider } from "./primitives";
import { StoryBlock } from "./blocks/story";
import { Entity360Block } from "./blocks/entity360";
import { AlerteBlock, ComparisonBlock, MissionBlock } from "./blocks/decision";
import { ArtifactBlock } from "./blocks/artifact";
import { VizBlock } from "./blocks/viz";
import { AnalyseBlock } from "./blocks/analyse";

export { WorkspaceAskProvider };

/**
 * LES RENDUS TYPÉS — un composant par forme, et rien qui sache tout afficher.
 *
 * Le registre en bas de fichier est exhaustif par construction : TypeScript refuse de compiler
 * si un type de bloc du protocole n'a pas son rendu. Une capacité ajoutée côté serveur ne peut
 * donc pas atterrir à l'écran sous forme de JSON — elle ne s'affiche pas du tout, jusqu'à ce
 * qu'on lui écrive son rendu.
 *
 * PRINCIPE VISUEL : ces blocs vivent DANS la conversation. Ils ne rivalisent pas avec elle —
 * pas de bordures épaisses, pas de couleurs d'accent, pas de titres criards. On lit une
 * réponse, et la donnée est là, tenue.
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODIFIER UNE VALEUR SUR PLACE — et pourquoi cela n'ouvre AUCUNE porte d'écriture.
 *
 * Le contrôle ci-dessous n'appelle aucune API. Il compose la phrase du serveur avec la valeur
 * saisie et l'envoie dans la conversation, exactement comme les boutons d'action. La
 * modification traverse donc la porte unique — proposition, carte de confirmation, action
 * canonique, RBAC revérifié, audit — et le PDG voit ce qu'il va changer AVANT que cela change.
 *
 * Conséquence directe : rendre un champ modifiable ne coûte rien en sécurité. C'est ce qui
 * permet d'en ouvrir beaucoup sans multiplier les chemins à protéger.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
function EditableValue({ f, children }: { f: WorkspaceField; children: React.ReactNode }) {
  const ask = React.useContext(AskContext);
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [sent, setSent] = React.useState(false);

  // Sans fournisseur, le champ reste en lecture seule : un crayon qui n'écrit nulle part
  // serait une promesse vide, et c'est précisément ce que ce produit refuse.
  if (!f.editable || !ask) return <>{children}</>;
  const ed = f.editable;

  const commit = () => {
    const v = draft.trim();
    if (!v || v === f.value) { setOpen(false); return; }
    setSent(true);
    setOpen(false);
    ask(ed.phrase.replace("%s", v));
  };

  if (sent) return <span className="chief-field-sent">Modification demandée…</span>;

  if (!open) {
    return (
      <span className="chief-editable">
        {children}
        <button
          type="button"
          className="chief-edit-btn"
          onClick={() => { setDraft(f.value); setOpen(true); }}
          title={`Modifier « ${f.label} »`}
          aria-label={`Modifier ${f.label}`}
        >
          <Pencil className="chief-edit-icon" aria-hidden />
        </button>
      </span>
    );
  }

  return (
    <span className="chief-edit-open">
      {ed.type === "choix" && ed.options?.length ? (
        <select className="chief-edit-input" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus>
          {ed.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input
          className="chief-edit-input"
          type={ed.type === "date" ? "date" : ed.type === "nombre" ? "number" : "text"}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          // Entrée valide, Échap renonce : au clavier, on ne doit jamais être coincé dans
          // un champ ouvert par erreur.
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
          }}
        />
      )}
      <button type="button" className="chief-edit-ok" onClick={commit} title="Demander la modification">
        <Check className="chief-edit-icon" aria-hidden />
      </button>
      <button type="button" className="chief-edit-cancel" onClick={() => setOpen(false)} title="Renoncer">×</button>
      {ed.aide ? <span className="chief-edit-help">{ed.aide}</span> : null}
    </span>
  );
}


const CANAL_ICON = { "e-mail": Mail, "téléphone": Phone, WhatsApp: MessageCircle } as const;

/**
 * Une adresse se copie plus souvent qu'elle ne se lit. Le clic la met dans le presse-papier.
 *
 * `ligne` change la DISPOSITION, pas la nature : sur une fiche unique, les coordonnées
 * s'empilent avec le pictogramme de leur canal — on distingue alors une adresse d'un numéro
 * sans lire, ce qui est exactement ce qu'on fait quand on cherche « comment la joindre ».
 * Côte à côte dans une liste de six personnes, ce serait au contraire du bruit.
 */
function Endpoint({ e, ligne = false }: { e: WorkspaceEndpoint; ligne?: boolean }) {
  const [copied, setCopied] = React.useState(false);
  const Icon = CANAL_ICON[e.canal] ?? Mail;
  const copy = React.useCallback(() => {
    navigator.clipboard?.writeText(e.valeur).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); },
      () => { /* Presse-papier refusé (contexte non sécurisé) : la valeur reste sélectionnable. */ },
    );
  }, [e.valeur]);

  return (
    <button
      type="button"
      onClick={copy}
      className={ligne ? "chief-endpoint chief-endpoint-line" : "chief-endpoint"}
      title="Copier"
    >
      {ligne ? <Icon className="chief-endpoint-icon" aria-hidden /> : null}
      <span className="chief-endpoint-value">{e.valeur}</span>
      {/* LA PROVENANCE SE DIT TOUJOURS. Une adresse « déduite » qu'on présente comme un fait
          est la façon la plus simple d'envoyer un contrat à la mauvaise personne. */}
      {e.fiabilite ? <span className="chief-endpoint-source">{e.fiabilite}</span> : null}
      {copied ? <span className="chief-endpoint-copied">copié</span> : null}
    </button>
  );
}

// ── Un rendu par type de bloc ─────────────────────────────────────────────────────────────

/** Les initiales, quand il n'y a pas de photo — deux lettres valent mieux qu'une silhouette. */
/**
 * LE VISAGE D'UNE PERSONNE — sa photo, ou ses initiales.
 *
 * La photo est servie par une route de l'ERP qui revérifie les droits ; si elle échoue (droit
 * retiré, fichier disparu), on retombe sur les initiales SANS que la fiche change de forme.
/**
 * LA FICHE D'UNE PERSONNE — ce qu'on demande vraiment quand on dit « montre-moi Raihana ».
 *
 * Pas la fiche RH. Trois choses : QUI c'est, comment la JOINDRE, et où elle en est de son
 * travail. Les trois chiffres à droite ne sont pas décoratifs — « 3 en retard » est souvent la
 * raison même de la question, et il doit se voir avant qu'on ait fini de lire le nom.
 *
 * Le reste (contrat, congés, historique) vit sur son écran : le lien y mène, et c'est le bon
 * endroit pour lui. Une fiche qui montre tout ne montre rien.
 */
function PersonCard({ p, standalone }: { p: WorkspacePerson; standalone: boolean }) {
  const sub = [p.poste, p.departement, p.entite].filter(Boolean).join(" · ");
  return (
    <div className={standalone ? "chief-profile" : "chief-profile chief-profile-compact"}>
      <div className="chief-profile-id">
        <Avatar nom={p.nom} photo={p.photo} taille={standalone ? "l" : "m"} />
        <div className="chief-profile-head">
          <p className="chief-profile-name">
            {p.href ? <Link href={p.href} className="chief-link-plain">{p.nom}</Link> : p.nom}
            {p.statut ? <Chip label={p.statut.label} ton={p.statut.ton} /> : null}
          </p>
          {sub ? <p className="chief-profile-role">{sub}</p> : null}
          {p.coordonnees.length > 0 ? (
            <div className={standalone ? "chief-endpoints chief-endpoints-stack" : "chief-endpoints"}>
              {p.coordonnees.map((e, j) => <Endpoint key={`${e.valeur}-${j}`} e={e} ligne={standalone} />)}
            </div>
          ) : (
            <p className="chief-block-empty">Aucune coordonnée enregistrée.</p>
          )}
        </div>
      </div>

      {p.metriques?.length ? (
        <dl className="chief-metrics">
          {p.metriques.map((m, i) => (
            <div key={`${m.label}-${i}`} className="chief-metric">
              <dt className={`chief-metric-value chief-tone-${m.ton ?? "neutre"}`}>{m.valeur}</dt>
              <dd className="chief-metric-label">{m.label}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function PeopleBlock({ b }: { b: Extract<WorkspaceBlock, { kind: "people" }> }) {
  const single = b.people.length === 1;
  return (
    // UNE SEULE PERSONNE : son NOM est le titre de la carte, il ne se répète pas dessous. Le
    // bandeau de titre disparaît donc, et la fiche occupe toute la carte.
    <Card title={b.title} hideHead={single} actions={b.actions}>
      <div className="chief-stack">
        {b.people.map((p, i) => <PersonCard key={`${p.nom}-${i}`} p={p} standalone={single} />)}
      </div>
      {b.note ? <p className="chief-block-note">{b.note}</p> : null}
    </Card>
  );
}

function DirectoryBlock({ b }: { b: Extract<WorkspaceBlock, { kind: "directory" }> }) {
  const [q, setQ] = React.useState("");
  const needle = q.trim().toLowerCase();
  // Le filtre est LOCAL et immédiat : re-poser la question pour restreindre une liste déjà à
  // l'écran coûterait un aller-retour complet pour une opération de lecture.
  const rows = needle
    ? b.rows.filter((r) =>
        [r.nom, r.poste, r.departement, r.entite, ...r.coordonnees.map((e) => e.valeur)]
          .filter(Boolean).join(" ").toLowerCase().includes(needle))
    : b.rows;
  const hidden = b.total - b.rows.length;

  return (
    <Card title={b.title} meta={`${b.total} personne${b.total > 1 ? "s" : ""}`}>
      {b.rows.length > 8 ? (
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filtrer…"
          aria-label="Filtrer l'annuaire"
          className="chief-block-filter"
        />
      ) : null}
      {/* DEUX RENDUS, PAS UN TABLEAU RÉTRÉCI.
          Sur 390 px, la colonne « Coordonnées » d'un tableau à trois colonnes se réduit à une
          quinzaine de pixels : l'adresse s'y écrit une lettre par ligne, verticalement. Ce
          n'est pas un défaut de style, c'est illisible. Le téléphone reçoit donc une LISTE de
          fiches — la même donnée, dans la forme que l'écran peut tenir. */}
      <div className="chief-table-scroll chief-only-wide">
        <table className="chief-table">
          <thead>
            <tr><th>Nom</th><th>Poste</th><th>Coordonnées</th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.nom}-${i}`}>
                <td className="chief-td-strong">{r.nom}</td>
                <td>{[r.poste, r.departement].filter(Boolean).join(" · ") || "—"}</td>
                <td>
                  {r.coordonnees.length === 0 ? (
                    <span className="chief-block-empty">non renseignée</span>
                  ) : (
                    <div className="chief-endpoints">
                      {r.coordonnees.map((e, j) => <Endpoint key={`${e.valeur}-${j}`} e={e} />)}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="chief-stack chief-only-narrow">
        {rows.map((r, i) => (
          <div key={`${r.nom}-${i}`} className="chief-person">
            <div className="chief-person-id">
              <span className="chief-person-name">{r.nom}</span>
              {[r.poste, r.departement].filter(Boolean).length ? (
                <span className="chief-person-role">{[r.poste, r.departement].filter(Boolean).join(" · ")}</span>
              ) : null}
            </div>
            {r.coordonnees.length === 0 ? (
              <p className="chief-block-empty">Coordonnée non renseignée.</p>
            ) : (
              <div className="chief-endpoints">
                {r.coordonnees.map((e, j) => <Endpoint key={`${e.valeur}-${j}`} e={e} />)}
              </div>
            )}
          </div>
        ))}
      </div>
      {rows.length === 0 ? <p className="chief-block-empty">Aucune ligne ne correspond à « {q} ».</p> : null}
      {hidden > 0 ? (
        <p className="chief-block-note">
          {hidden} autre{hidden > 1 ? "s" : ""} non affichée{hidden > 1 ? "s" : ""} — la liste complète est dans <Link href="/rh">Ressources humaines</Link>.
        </p>
      ) : null}
      {b.note ? <p className="chief-block-note">{b.note}</p> : null}
    </Card>
  );
}

/**
 * « Deepak Sharma <deepak@fournisseur.in> » se lit mal. Le nom porte l'information, l'adresse
 * la précise : on les sépare quand la source les a réunies, sans jamais perdre l'adresse —
 * deux « Deepak » dans deux sociétés, c'est le domaine qui les distingue.
 */
function splitSender(raw: string): { name: string; address: string | null } {
  const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(raw);
  if (!m || !m[1].trim()) return { name: raw, address: null };
  return { name: m[1].trim().replace(/^"|"$/g, ""), address: m[2].trim() };
}

function MailBlock({ b }: { b: Extract<WorkspaceBlock, { kind: "mail" }> }) {
  return (
    <Card title={b.title}>
      <ul className="chief-stack chief-list">
        {b.messages.map((m, i) => {
          const from = splitSender(m.de);
          return (
          <li key={m.id ?? `${m.de}-${i}`} className="chief-mail">
            <div className="chief-mail-head">
              <span className="chief-mail-from">
                {from.name}
                {from.address ? <span className="chief-mail-address">{from.address}</span> : null}
              </span>
              {m.recuLe ? <span className="chief-mail-date">{m.recuLe}</span> : null}
            </div>
            <p className="chief-mail-subject">{m.objet}</p>
            {m.extrait ? <p className="chief-mail-snippet">{deballerUntrusted(m.extrait)}</p> : null}
            {m.demandes?.length ? (
              <p className="chief-mail-asks">
                {/* Formulé comme un RAPPORT : ce que l'expéditeur demande n'est pas une consigne
                    pour Adam, et l'écran ne doit pas le laisser croire. */}
                Demande de l&apos;expéditeur : {m.demandes.join(" · ")}
              </p>
            ) : null}
            {m.piecesJointes?.length ? (
              <p className="chief-mail-files">{m.piecesJointes.join(" · ")}</p>
            ) : null}
            {m.alerte?.length ? (
              <p className="chief-mail-alert">Message suspect : {m.alerte.join(" · ")}</p>
            ) : null}
          </li>
          );
        })}
      </ul>
    </Card>
  );
}

function AgendaBlock({ b }: { b: Extract<WorkspaceBlock, { kind: "agenda" }> }) {
  return (
    <Card title={b.title}>
      <ul className="chief-stack chief-list">
        {b.events.map((e, i) => (
          <li key={`${e.titre}-${i}`} className="chief-event">
            <div className="chief-event-when">
              {e.heure ? <span className="chief-event-hour">{e.heure}</span> : null}
              {e.jour ? <span className="chief-event-day">{e.jour}</span> : null}
            </div>
            <div className="chief-event-body">
              <p className="chief-event-title">{e.titre}</p>
              {[e.lieu, e.organisateur].filter(Boolean).length ? (
                <p className="chief-event-meta">{[e.lieu, e.organisateur].filter(Boolean).join(" · ")}</p>
              ) : null}
              {e.invites?.length ? <p className="chief-event-meta">{e.invites.join(", ")}</p> : null}
              {e.visio ? (
                <a href={e.visio} target="_blank" rel="noreferrer" className="chief-link">Rejoindre</a>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function QueueBlock({ b }: { b: Extract<WorkspaceBlock, { kind: "queue" }> }) {
  const hidden = b.total - b.items.length;
  // UN NOMBRE NU NE DIT RIEN. « 2 » posé en haut à droite d'une liste de deux lignes ne fait que
  // répéter ce qu'on voit. Le compte n'apporte quelque chose QUE s'il annonce ce qui manque.
  return (
    <Card title={b.title} meta={hidden > 0 ? `${b.items.length} sur ${b.total}` : undefined}>
      <ul className="chief-stack chief-list">
        {b.items.map((it, i) => (
          <li key={`${it.titre}-${i}`} className="chief-queue-item">
            <div className="chief-queue-body">
              <p className="chief-queue-title">
                {it.href ? <Link href={it.href} className="chief-link">{it.titre}</Link> : it.titre}
              </p>
              {it.detail ? <p className="chief-queue-detail">{it.detail}</p> : null}
            </div>
            <div className="chief-queue-side">
              {it.statut ? <span className="chief-chip">{it.statut}</span> : null}
              {it.echeance ? <span className="chief-queue-date">{it.echeance}</span> : null}
              {/* TRANCHER SANS PARTIR. Le lien reste — il mène à la demande complète, avec ses
                  pièces — mais il n'est plus la SEULE issue. */}
              {it.actions?.length ? <ActionRow actions={it.actions} /> : null}
            </div>
          </li>
        ))}
      </ul>
      {hidden > 0 ? <p className="chief-block-note">{hidden} de plus dans <Link href="/validations">Validations</Link>.</p> : null}
    </Card>
  );
}

function RecordBlock({ b }: { b: Extract<WorkspaceBlock, { kind: "record" }> }) {
  return (
    <Card title={b.title} meta={b.subtitle ?? undefined}>
      <dl className="chief-fields">
        {b.fields.map((f, i) => (
          <div key={`${f.label}-${i}`} className="chief-field">
            <dt>{f.label}</dt>
            <dd><EditableValue f={f}>{f.value}</EditableValue></dd>
          </div>
        ))}
      </dl>
      {b.href ? <p className="chief-block-note"><Link href={b.href} className="chief-link">Ouvrir la fiche</Link></p> : null}
    </Card>
  );
}

/**
 * LE TABLEAU — et son geste par ligne.
 *
 * Ce qui change par rapport à un tableau de rapport : la dernière colonne n'est pas une donnée,
 * c'est une SORTIE. Après avoir lu « NIN-2026-015 · 4 jours de retard », la question suivante
 * porte sur cette ligne-là ; l'obliger à retaper la référence, c'est lui faire recopier ce
 * qu'il a sous les yeux.
 *
 * Sur téléphone, la même donnée devient une LISTE. Un tableau à six colonnes comprimé sur
 * 390 px n'est pas un tableau dense, c'est un tableau illisible.
 */
function TableBlock({ b }: { b: Extract<WorkspaceBlock, { kind: "table" }> }) {
  const hidden = (b.total ?? b.rows.length) - b.rows.length;
  const hasRowActions = b.rows.some((r) => r.actions?.length);
  const cell = (r: (typeof b.rows)[number], key: string) => {
    const value = r.cells[key] ?? "—";
    const ton = r.tons?.[key];
    return ton && ton !== "neutre" ? <Chip label={value} ton={ton} /> : value;
  };

  return (
    <Card title={b.title} meta={hidden > 0 ? `${b.rows.length} sur ${b.total}` : undefined} actions={b.actions}>
      <div className="chief-table-scroll chief-only-wide">
        <table className="chief-table">
          <thead>
            <tr>
              {b.columns.map((c) => <th key={c.key} className={c.numeric ? "chief-num" : undefined}>{c.label}</th>)}
              {hasRowActions ? <th aria-label="Actions" /> : null}
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r, i) => (
              <tr key={i}>
                {b.columns.map((c, j) => (
                  <td key={c.key} className={[c.numeric ? "chief-num" : "", j === 0 ? "chief-td-strong" : ""].filter(Boolean).join(" ") || undefined}>
                    {j === 0 && r.href ? <Link href={r.href} className="chief-link-plain">{cell(r, c.key)}</Link> : cell(r, c.key)}
                  </td>
                ))}
                {hasRowActions ? (
                  <td className="chief-td-actions">{r.actions?.length ? <ActionRow actions={r.actions} /> : null}</td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="chief-stack chief-only-narrow">
        {b.rows.map((r, i) => (
          <div key={i} className="chief-rowcard">
            <p className="chief-rowcard-title">
              {r.href ? <Link href={r.href} className="chief-link-plain">{r.cells[b.columns[0]?.key ?? ""] ?? "—"}</Link> : (r.cells[b.columns[0]?.key ?? ""] ?? "—")}
            </p>
            <dl className="chief-rowcard-fields">
              {b.columns.slice(1).map((c) => (
                <div key={c.key}>
                  <dt>{c.label}</dt>
                  <dd>{cell(r, c.key)}</dd>
                </div>
              ))}
            </dl>
            {r.actions?.length ? <ActionRow actions={r.actions} /> : null}
          </div>
        ))}
      </div>

      {hidden > 0 ? <p className="chief-block-note">{hidden} ligne{hidden > 1 ? "s" : ""} de plus non affichée{hidden > 1 ? "s" : ""}.</p> : null}
    </Card>
  );
}

/**
 * LE DOSSIER — l'objet montré en entier, dans l'ordre de la question.
 *
 * D'abord ce qui bloque (l'étape courante et l'alerte), puis les faits, puis seulement les
 * pièces, les gens et l'histoire. Cet ordre n'est pas esthétique : quand le PDG ouvre un
 * dossier en retard, sa question est « pourquoi ça n'avance pas ? », et la réponse doit être
 * la première chose que l'œil rencontre.
 */
function DossierBlock({ b }: { b: Extract<WorkspaceBlock, { kind: "dossier" }> }) {
  return (
    <Card title={b.title} hideHead actions={b.actions}>
      <header className="chief-dossier-head">
        <div className="chief-dossier-id">
          <p className="chief-dossier-ref">
            {b.href ? <Link href={b.href} className="chief-link-plain">{b.title}</Link> : b.title}
            {b.badge ? <Chip label={b.badge.label} ton={b.badge.ton} /> : null}
          </p>
          {b.subtitle ? <p className="chief-dossier-sub">{b.subtitle}</p> : null}
        </div>
      </header>

      {/* DEUX COLONNES SUR GRAND ÉCRAN, et ce n'est pas décoratif.
          Les FAITS (qui, quand, combien de retard) tiennent à gauche, en lecture verticale ;
          l'AVANCEMENT et ses pièces occupent la droite, qui est la zone large. Empilé sur une
          seule colonne, ce même contenu laissait la moitié droite de la carte vide sur 1440 px
          et poussait les actions à 750 px du titre — la capture de revue l'a montré. */}
      <div className="chief-dossier-grid">
        <div className="chief-dossier-facts">
          {b.fields.length ? (
            <dl className="chief-fields chief-fields-stacked">
              {b.fields.map((f, i) => (
                <div key={`${f.label}-${i}`} className="chief-field">
                  <dt>{f.label}</dt>
                  {/* UN CHAMP QUI DÉSIGNE QUELQU'UN PORTE SON VISAGE. « Responsable : Raihana »
                      est la ligne qu'on cherche en premier sur un dossier bloqué ; avec la
                      photo, elle se trouve sans être lue. */}
                  <dd className={f.ton && f.ton !== "neutre" ? `chief-tone-${f.ton}` : undefined}>
                    <EditableValue f={f}>
                      {f.avatar ? (
                        <span className="chief-field-person">
                          <Avatar nom={f.avatar.nom} photo={f.avatar.photo} taille="s" />
                          {f.value}
                        </span>
                      ) : f.value}
                    </EditableValue>
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>

        <div className="chief-dossier-body">
        {b.steps?.length ? <Stepper steps={b.steps} /> : null}

        {b.alerte ? (
          <p className={`chief-alert chief-alert-${b.alerte.ton}`}>
            <span className="chief-alert-label">Blocage</span> {b.alerte.label}
          </p>
        ) : null}

        {b.docs?.length ? (
          <div className="chief-dossier-section">
            <p className="chief-dossier-section-title">Documents ({b.docs.length})</p>
            <ul className="chief-doc-grid chief-list">
              {b.docs.map((d, i) => (
                <li key={`${d.href}-${i}`}>
                  <Link href={d.href} className="chief-doc-tile">
                    <span className={`chief-doc-badge chief-doc-${d.type}`}>{extLabel(d)}</span>
                    <span className="chief-doc-tile-name">{d.nom}</span>
                    {/* Taille ET date : « 320 ko » dit le poids, « 18/08 » dit si la pièce est
                        celle qu'on attend. Sur un dossier en retard, la seconde compte plus. */}
                    {d.taille || d.date ? (
                      <span className="chief-doc-tile-meta">{[d.taille, d.date].filter(Boolean).join(" · ")}</span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {b.participants?.length ? (
          <div className="chief-dossier-section">
            {/* « Voir tout » n'apparaît QUE s'il y a un écran où aller. Un lien mort sous une
                liste tronquée est pire que la troncature elle-même : il promet le reste. */}
            <p className="chief-dossier-section-title">
              Participants ({b.participants.length})
              {b.href ? <Link href={b.href} className="chief-section-link">Voir tout</Link> : null}
            </p>
            <ul className="chief-list chief-participants">
              {b.participants.map((p, i) => (
                <li key={`${p.nom}-${i}`} className="chief-participant">
                  <Avatar nom={p.nom} photo={p.photo} taille="s" />
                  <span className="chief-participant-id">
                    <span className="chief-participant-name">{p.nom}</span>
                    {p.poste ? <span className="chief-participant-role">{p.poste}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {b.activite?.length ? (
          <div className="chief-dossier-section">
            <p className="chief-dossier-section-title">Dernières activités</p>
            <ol className="chief-timeline chief-timeline-tight">
              {b.activite.map((a, i) => (
                <li key={i} className="chief-timeline-step">
                  {a.date ? <span className="chief-timeline-date">{a.date}</span> : null}
                  <p className="chief-timeline-label">{a.label}</p>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        </div>
      </div>
    </Card>
  );
}

const DOC_LABEL: Record<WorkspaceDoc["type"], string> = {
  pdf: "PDF", image: "IMG", feuille: "XLS", texte: "TXT", autre: "DOC",
};
const extLabel = (d: WorkspaceDoc): string => {
  const ext = (d.nom.split(".").pop() ?? "").toUpperCase();
  return ext.length >= 2 && ext.length <= 4 ? ext : DOC_LABEL[d.type];
};

/** La frise du circuit : où en est le dossier, et combien il reste d'étapes. */
function Stepper({ steps }: { steps: WorkspaceStep[] }) {
  return (
    <ol className="chief-stepper" aria-label="Circuit du dossier">
      {steps.map((st, i) => (
        <li key={`${st.label}-${i}`} className={`chief-step chief-step-${st.etat}`}>
          <span className="chief-step-dot" aria-hidden>{st.etat === "fait" ? "✓" : i + 1}</span>
          <span className="chief-step-label">{st.label}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * LE MESSAGE PRÊT — montré comme un message.
 *
 * « De : / À : / Objet : / Corps : » recopié en prose oblige à relire pour vérifier une
 * adresse. Ici les champs sont des champs, le corps est du corps, et le bouton d'envoi est à
 * côté — pas au bout d'une phrase.
 *
 * LE CLIC N'ENVOIE PAS DEPUIS L'ÉCRAN. Il écrit « Envoie » dans la conversation, ce qui
 * emprunte exactement le chemin de l'accord parlé : même approbation, même action canonique,
 * même audit. C'est la règle qui a survécu au blocage des cinq « oui envoie ».
 */
function EmailBlock({ b }: { b: Extract<WorkspaceBlock, { kind: "email" }> }) {
  const sent = b.statut === "envoye";
  return (
    // LES GESTES MONTENT À CÔTÉ DU MESSAGE, ils ne restent pas en pied de carte. C'est le seul
    // bloc où le geste principal — envoyer — est aussi le plus engageant : le poser à hauteur
    // du corps, en colonne, le rend impossible à confondre avec « relire » ou « modifier ».
    <Card title={b.title} hideHead>
      <div className={`chief-email${sent ? " chief-email-sent" : ""}`}>
        <span className="chief-email-icon" aria-hidden><Mail /></span>
        <div className="chief-email-main">
          <dl className="chief-email-head">
            <div><dt>À</dt><dd>{b.a.join(", ")}</dd></div>
            {b.cc?.length ? <div><dt>Cc</dt><dd>{b.cc.join(", ")}</dd></div> : null}
            <div><dt>Objet</dt><dd className="chief-email-subject">{b.objet}</dd></div>
          </dl>
          <p className="chief-email-body">{b.corps}</p>
          {b.piecesJointes?.length ? (
            <p className="chief-email-attachments">
              {b.piecesJointes.map((f) => <span key={f} className="chief-chip">{f}</span>)}
            </p>
          ) : null}
        </div>
        {!sent && b.actions?.length ? (
          <div className="chief-email-side"><ActionRow actions={b.actions} /></div>
        ) : null}
      </div>
      {sent ? (
        <p className="chief-email-status">
          <span className="chief-tone-succes" aria-hidden>✓</span> Envoyé à {b.a.join(", ")}
          {b.envoyeLe ? ` · ${b.envoyeLe}` : ""}
        </p>
      ) : null}
      {b.statut === "annule" ? <p className="chief-block-note">Annulé — ce message ne partira pas.</p> : null}
    </Card>
  );
}

/**
 * UNE PLANIFICATION (§11) — l'objet, pas la promesse.
 *
 * Quand Adam dit « c'est noté, chaque lundi », la seule preuve que quelque chose existe est cette
 * carte : une cadence en toutes lettres, la prochaine exécution, l'état, et les derniers passages.
 * Sans elle, l'utilisateur devrait CROIRE qu'une planification a été créée — et découvrirait
 * trois semaines plus tard qu'elle n'avait jamais tourné.
 */
function PlanificationBlock({ b }: { b: Extract<WorkspaceBlock, { kind: "planification" }> }) {
  const paused = b.etat === "en-pause";
  return (
    <Card title={b.title} actions={b.actions}>
      <dl className="chief-fields">
        <div><dt>Cadence</dt><dd>{b.cadence}</dd></div>
        <div>
          <dt>Prochaine exécution</dt>
          {/* Une planification en pause n'a pas de « prochaine exécution » : l'afficher quand même
              ferait attendre un rapport qui ne viendra pas. */}
          <dd>{paused ? "— (en pause)" : b.prochaine}</dd>
        </div>
        <div><dt>Déclenche</dt><dd>{b.traitement}</dd></div>
        <div>
          <dt>État</dt>
          <dd className={paused ? "chief-tone-attention" : "chief-tone-succes"}>
            {paused ? "En pause" : "Active"}
          </dd>
        </div>
      </dl>
      {b.passages?.length ? (
        <ol className="chief-timeline">
          {b.passages.slice(0, 3).map((r, i) => (
            <li key={`${r.date}-${i}`} className="chief-timeline-step">
              <span className="chief-timeline-date">{r.date}</span>
              <div>
                {/* « Sans effet » n'est PAS un échec : confondre les deux ferait passer une base à
                    jour pour une panne, et c'est justement la question qu'on se pose ici. */}
                <p className="chief-timeline-label">
                  {r.resultat === "ok" ? "Exécutée" : r.resultat === "sans-effet" ? "Rien à faire" : "En échec"}
                </p>
                {r.detail ? <p className="chief-timeline-detail">{r.detail}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="chief-block-note">Jamais encore exécutée.</p>
      )}
    </Card>
  );
}

function TimelineBlock({ b }: { b: Extract<WorkspaceBlock, { kind: "timeline" }> }) {
  return (
    <Card title={b.title}>
      <ol className="chief-timeline">
        {b.steps.map((st, i) => (
          <li key={`${st.label}-${i}`} className="chief-timeline-step">
            {st.date ? <span className="chief-timeline-date">{st.date}</span> : null}
            <div>
              <p className="chief-timeline-label">{st.label}</p>
              {st.detail ? <p className="chief-timeline-detail">{st.detail}</p> : null}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/**
 * LES JAUGES — « il reste combien ? » répondu par une longueur.
 *
 * La barre est bornée à 100 % pour ne pas déborder de la carte, MAIS le chiffre, lui, ne l'est
 * pas : un dépassement s'écrit « 112 % » et se colore. Rogner la valeur affichée pour faire
 * joli reviendrait à cacher exactement l'information qui compte.
 */
function Gauge({ g }: { g: WorkspaceGauge }) {
  const pct = g.total && g.total > 0 ? (g.valeur / g.total) * 100 : g.valeur;
  const shown = Math.max(0, Math.min(100, pct));
  const ton = g.ton ?? (pct >= 100 ? "alerte" : pct >= 85 ? "attention" : "neutre");
  const fmt = (n: number) => new Intl.NumberFormat("fr-DZ").format(Math.round(n));
  const right = g.detail
    ?? (g.total && g.total > 0 ? `${fmt(g.valeur)} / ${fmt(g.total)}${g.unite ? ` ${g.unite}` : ""}` : null);
  return (
    <li className="chief-gauge">
      <div className="chief-gauge-head">
        <span className="chief-gauge-label">{g.label}</span>
        <span className={`chief-gauge-pct chief-tone-${ton}`}>{Math.round(pct)} %</span>
      </div>
      <div
        className="chief-gauge-track"
        role="progressbar"
        aria-label={g.label}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span className={`chief-gauge-fill chief-tone-${ton}`} style={{ width: `${shown}%` }} />
      </div>
      {right ? <p className="chief-gauge-detail">{right}</p> : null}
    </li>
  );
}

function ProgressBlock({ b }: { b: Extract<WorkspaceBlock, { kind: "progress" }> }) {
  return (
    <Card title={b.title}>
      <ul className="chief-stack chief-list">
        {b.gauges.map((g, i) => <Gauge key={`${g.label}-${i}`} g={g} />)}
      </ul>
      {b.note ? <p className="chief-block-note">{b.note}</p> : null}
    </Card>
  );
}

/**
 * UN DOCUMENT MONTRÉ SUR PLACE.
 *
 * « Je ne peux pas afficher un fichier Excel », répondu en production, était faux — mais rien
 * ne le démentait à l'écran. Ici, chaque type a son rendu :
 *
 *   • un PDF s'ouvre dans un cadre, replié par défaut : un contrat de quarante pages qui se
 *     déroule sous la réponse pousse la conversation hors de l'écran ;
 *   • une IMAGE s'affiche, bornée en hauteur ;
 *   • une FEUILLE arrive déjà LUE par le serveur — c'est ce qui permet de relire un export
 *     AVANT de l'envoyer, sans ouvrir Excel ;
 *   • le reste se télécharge, et on le dit plutôt que de prétendre l'afficher.
 *
 * Le `src` est une route de l'ERP qui revérifie les droits : le cadre n'ouvre rien que la
 * personne n'aurait pu ouvrir elle-même sur l'écran du module.
 */
function DocumentView({ d }: { d: WorkspaceDoc }) {
  const [open, setOpen] = React.useState(d.type === "image" || d.type === "feuille");
  const feuille = d.feuille;
  return (
    <li className="chief-doc">
      <div className="chief-doc-head">
        <div className="chief-doc-id">
          <p className="chief-doc-name">{d.nom}</p>
          <p className="chief-doc-meta">
            {[d.soustitre, d.taille, d.pages ? `${d.pages} page${d.pages > 1 ? "s" : ""}` : null]
              .filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="chief-doc-tools">
          {d.type === "pdf" || d.type === "image" ? (
            <button type="button" className="chief-action" onClick={() => setOpen((v) => !v)}>
              {open ? "Replier" : "Afficher"}
            </button>
          ) : null}
          <a className="chief-action" href={`${d.href}${d.href.includes("?") ? "&" : "?"}dl=1`}>Télécharger</a>
        </div>
      </div>

      {open && d.type === "pdf" ? (
        <iframe className="chief-doc-frame" src={d.href} title={d.nom} loading="lazy" />
      ) : null}
      {open && d.type === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element -- route ERP dynamique, dimensions inconnues
        <img className="chief-doc-image" src={d.href} alt={d.nom} loading="lazy" />
      ) : null}
      {feuille && feuille.rows.length > 0 ? (
        <>
          <div className="chief-table-scroll">
            <table className="chief-table">
              <thead>
                <tr>{feuille.columns.map((c) => <th key={c.key} className={c.numeric ? "chief-num" : undefined}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {feuille.rows.map((r, i) => (
                  <tr key={i}>
                    {feuille.columns.map((c) => <td key={c.key} className={c.numeric ? "chief-num" : undefined}>{r[c.key] ?? "—"}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {feuille.total > feuille.rows.length ? (
            <p className="chief-block-note">
              {feuille.total - feuille.rows.length} ligne{feuille.total - feuille.rows.length > 1 ? "s" : ""} de plus dans le fichier.
            </p>
          ) : null}
        </>
      ) : null}
      {d.type === "autre" || (d.type === "feuille" && !feuille) ? (
        <p className="chief-block-note">Aperçu indisponible pour ce format — le fichier reste téléchargeable.</p>
      ) : null}
    </li>
  );
}

function DocumentBlock({ b }: { b: Extract<WorkspaceBlock, { kind: "document" }> }) {
  return (
    <Card title={b.title} meta={b.docs.length > 1 ? `${b.docs.length}` : undefined}>
      <ul className="chief-stack chief-list">
        {b.docs.map((d, i) => <DocumentView key={`${d.href}-${i}`} d={d} />)}
      </ul>
      {b.note ? <p className="chief-block-note">{b.note}</p> : null}
    </Card>
  );
}

/**
 * LE REGISTRE. Le type de retour force l'exhaustivité : si le protocole gagne un type de bloc
 * sans rendu, la compilation échoue ici — pas à l'exécution, et pas sur l'écran du PDG.
 */
/**
 * UN MINI-TABLEAU DE BORD (§35) — des tuiles sur une grille, chacune rendue par le REGISTRE : le
 * tableau de bord ne sait rien dessiner lui-même, il place. Une tuile est un bloc ordinaire (une
 * représentation, des jauges, un tableau, une fiche), relue par le même lecteur que les autres.
 */
function DashboardBlock({ b }: { b: Extract<WorkspaceBlock, { kind: "dashboard" }> }) {
  return (
    <Card title={b.title} meta={`${b.tuiles.length} tuile${b.tuiles.length > 1 ? "s" : ""}`} actions={b.actions}>
      <div className={`chief-dashboard${b.colonnes === 3 ? " chief-dashboard-3" : ""}`} data-tuiles={b.tuiles.length}>
        {b.tuiles.map((t, i) => (
          <div key={t.blockId ?? i} className="chief-tuile"><WorkspaceOneBlock b={t} /></div>
        ))}
      </div>
      {b.note ? <p className="chief-block-note">{b.note}</p> : null}
    </Card>
  );
}

const RENDERERS: { [K in WorkspaceBlock["kind"]]: (p: { b: Extract<WorkspaceBlock, { kind: K }> }) => React.ReactElement } = {
  story: StoryBlock,
  entity360: Entity360Block,
  comparison: ComparisonBlock,
  mission: MissionBlock,
  alerte: AlerteBlock,
  people: PeopleBlock,
  directory: DirectoryBlock,
  mail: MailBlock,
  agenda: AgendaBlock,
  queue: QueueBlock,
  record: RecordBlock,
  table: TableBlock,
  timeline: TimelineBlock,
  progress: ProgressBlock,
  document: DocumentBlock,
  dossier: DossierBlock,
  planification: PlanificationBlock,
  email: EmailBlock,
  artifact: ArtifactBlock,
  viz: VizBlock,
  analyse: AnalyseBlock,
  dashboard: DashboardBlock,
};

/**
 * UN SEUL BLOC.
 *
 * Extrait de `WorkspaceBlocks` pour que le rangement par TOUR puisse placer chaque objet lui-même
 * — et surtout glisser les gestes qui le concernent JUSTE EN DESSOUS (§14). Tant que le rendu ne
 * savait dessiner qu'une composition entière, le bouton de confirmation ne pouvait pas suivre son
 * objet : il finissait en bas de page, loin de la chose qu'il confirme.
 */
export function WorkspaceOneBlock({ b }: { b: WorkspaceBlock }) {
  // LA RÉPARTITION PASSE PAR LE REGISTRE, PAS PAR UN `switch`.
  //
  // Il y en avait DEUX, identiques, de dix-huit cas chacun : un pour le bloc seul, un pour la
  // composition. Ajouter un type de bloc demandait donc de penser aux deux — et le second a
  // effectivement été oublié le jour où le protocole a gagné cinq types.
  //
  // Le `Renderer` ci-dessous est la SEULE conversion de type du fichier. Elle est sûre par
  // construction : `RENDERERS` est typé `{ [K in kind]: (p: { b: Extract<…, K> }) => Element }`,
  // donc TypeScript refuse déjà de compiler si un type de bloc n'a pas son rendu. La conversion
  // ne fait que dire au compilateur ce que l'indexation par `b.kind` garantit déjà.
  const Renderer = RENDERERS[b.kind] as (p: { b: WorkspaceBlock }) => React.ReactElement;
  return <Renderer b={b} />;
}

export function WorkspaceBlocks({ composition }: { composition: WorkspaceComposition }) {
  if (composition.blocks.length === 0) return null;
  return (
    <div className="chief-workspace-blocks">
      {composition.blocks.map((b, i) => (
        <WorkspaceOneBlock key={b.blockId ?? i} b={b} />
      ))}
    </div>
  );
}
