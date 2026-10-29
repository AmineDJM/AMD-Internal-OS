"use client";

import * as React from "react";
import Link from "next/link";

import { FilterX, Check, Paperclip } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn, formatDate, formatDateTime } from "@/lib/utils";
import { MAIL_DIRECTION } from "@/lib/labels";
import { setMailDate } from "@/lib/actions/mail-register-actions";
import { PartagerButton } from "@/components/shared/partager-button";
import { useAction } from "@/components/shared/use-action";

/**
 * LE CARNET DE COURRIERS — un tableau qu'on FILTRE, parce qu'on y cherche toujours une pièce
 * précise (« le courrier à la CNAS de mars ») dans plusieurs centaines de lignes.
 *
 * Les deux dates qui manquent le plus souvent — l'ARRIVÉE et l'ACCUSÉ — se posent ici, dans la
 * ligne : elles se constatent des jours après la saisie, et rouvrir un formulaire complet pour
 * cocher une date, personne ne le fait. Ce qu'on ne peut pas remplir en un geste reste vide.
 *
 * Tout le reste — joindre le scan, corriger un champ, relire le journal — se fait sur la FICHE,
 * qu'on ouvre en cliquant l'objet.
 */

export interface MailRow {
  id: string;
  reference: string | null;
  title: string;
  direction: string;
  sender: string | null;
  recipient: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  acknowledgedAt: string | null;
  carrier: string | null;
  /** Entité concernée et partenaire — deux colonnes qu'on cherche en retrouvant un pli
   *  (« le courrier de Pharmagène à North Tech »). */
  companyName: string;
  partnerName: string;
  /** À QUI le pli s'adresse en interne : la direction, la personne, ou les deux. */
  departmentName: string;
  concernedName: string;
  /** Nombre de pièces jointes — un courrier sans pièce se repère d'un coup d'œil. */
  attachments: number;
}

const cellInput = "h-9 w-full rounded-md border border-input bg-card px-2 text-base sm:h-8 sm:text-xs font-normal normal-case tracking-normal outline-none focus:ring-1 focus:ring-ring";

/** Une date qui se pose (ou s'efface) en un clic depuis la ligne. */
function DateCell({ id, field, value, canEdit }: {
  id: string; field: "receivedAt" | "acknowledgedAt"; value: string | null; canEdit: boolean;
}) {
  // Une cellule n'a pas de place pour parler : un refus (date invalide…) part en avis flottant.
  const { busy, run } = useAction({ signalerErreurs: true });
  if (!canEdit) return <span className="text-muted-foreground">{value ? formatDate(value) : "—"}</span>;

  const save = (v: string | null) => {
    void run(() => setMailDate({ id, field, value: v }));
  };

  if (value) {
    return (
      <button type="button" disabled={busy} onClick={() => save(null)}
        title="Effacer cette date" className="text-left text-xs hover:underline disabled:opacity-50">
        {formatDate(value)}
      </button>
    );
  }
  return (
    <button type="button" disabled={busy}
      onClick={() => save(new Date().toISOString())}
      title="Marquer à aujourd'hui"
      className="inline-flex min-h-8 items-center gap-1 rounded-md border border-dashed border-input px-2 py-0.5 text-[0.6875rem] sm:min-h-0 sm:px-1.5 text-muted-foreground hover:bg-secondary disabled:opacity-50">
      <Check className="h-3 w-3" /> aujourd&apos;hui
    </button>
  );
}

const EMPTY_FILTERS = { title: "", reference: "", direction: "", party: "", concerns: "", sentMonth: "", receivedMonth: "", ack: "" };

export function MailTable({ rows, canEdit }: { rows: MailRow[]; canEdit: boolean }) {
  const [f, setF] = React.useState({ ...EMPTY_FILTERS });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));
  const has = (hay: string | null, needle: string) => (hay ?? "").toLowerCase().includes(needle.toLowerCase());
  // Les dates se filtrent AU MOIS : c'est ainsi qu'on cherche un pli (« le courrier à la CNAS de
  // mars ») — un jour exact serait trop fin, une plage à deux bornes trop lourde pour un carnet.
  const inMonth = (iso: string | null, month: string) => Boolean(iso && iso.startsWith(month));

  const shown = rows.filter((r) => {
    if (f.title && !has(r.title, f.title)) return false;
    if (f.reference && !has(r.reference, f.reference)) return false;
    if (f.direction && r.direction !== f.direction) return false;
    if (f.party && !has(r.sender, f.party) && !has(r.recipient, f.party)) return false;
    // « Concerne » cherche dans la direction ET dans la personne : on tape « finances » ou un nom
    // propre sans avoir à savoir lequel des deux champs avait été rempli.
    if (f.concerns && !has(r.departmentName, f.concerns) && !has(r.concernedName, f.concerns)) return false;
    if (f.sentMonth && !inMonth(r.sentAt, f.sentMonth)) return false;
    if (f.receivedMonth && !inMonth(r.receivedAt, f.receivedMonth)) return false;
    // « Sans accusé » : la seule question qui fasse rouvrir le carnet.
    if (f.ack === "without" && r.acknowledgedAt) return false;
    if (f.ack === "with" && !r.acknowledgedAt) return false;
    return true;
  });

  const active = Object.values(f).some(Boolean);
  const noAck = rows.filter((r) => !r.acknowledgedAt).length;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{shown.length} / {rows.length} courrier{rows.length > 1 ? "s" : ""}</span>
        <button
          type="button" onClick={() => setF((p) => ({ ...p, ack: p.ack === "without" ? "" : "without" }))}
          className={cn("inline-flex min-h-9 items-center gap-1 rounded-md border px-2.5 py-1 font-medium sm:min-h-0 sm:px-2",
            f.ack === "without" ? "border-warning/60 bg-warning/10 text-warning" : "border-input hover:bg-secondary")}
        >
          Sans accusé de réception ({noAck})
        </button>
        {active && (
          <button type="button" onClick={() => setF({ ...EMPTY_FILTERS })}
            className="inline-flex min-h-9 items-center gap-1 rounded-md border border-input px-2.5 py-1 font-medium hover:bg-secondary sm:min-h-0 sm:px-2">
            <FilterX className="h-3.5 w-3.5" /> Réinitialiser
          </button>
        )}
      </div>

      <div className="surface overflow-x-auto">
        <table className="w-full min-w-[68rem] border-collapse text-sm">
          <thead className="border-b border-border">
            <tr className="text-xs uppercase tracking-wide text-muted-foreground">
              <th className="sticky left-0 z-10 bg-card px-3 pt-2 text-left font-medium">Chrono</th>
              <th className="px-3 pt-2 text-left font-medium">Sens</th>
              <th className="px-3 pt-2 text-left font-medium">Objet</th>
              <th className="px-3 pt-2 text-left font-medium">Expéditeur</th>
              <th className="px-3 pt-2 text-left font-medium">Destinataire</th>
              <th className="px-3 pt-2 text-left font-medium">Départ</th>
              <th className="px-3 pt-2 text-left font-medium">Arrivée</th>
              <th className="px-3 pt-2 text-left font-medium">Accusé</th>
              <th className="px-3 pt-2 text-left font-medium">Concerne</th>
              <th className="px-3 pt-2 text-left font-medium">Entité</th>
              <th className="px-3 pt-2 text-left font-medium">Partenaire</th>
              <th className="px-3 pt-2 text-left font-medium">Porteur</th>
              <th className="px-3 pt-2 text-left font-medium"><Paperclip className="h-3.5 w-3.5" aria-label="Pièces jointes" /></th>
            </tr>
            <tr>
              <th className="sticky left-0 z-10 bg-card px-2 pb-2 pt-1"><input value={f.reference} onChange={set("reference")} placeholder="Filtrer" className={cellInput} /></th>
              <th className="px-2 pb-2 pt-1">
                <select value={f.direction} onChange={set("direction")} className={cellInput}>
                  <option value="">Tous</option>
                  {Object.entries(MAIL_DIRECTION).map(([v, d]) => <option key={v} value={v}>{d.label}</option>)}
                </select>
              </th>
              <th className="px-2 pb-2 pt-1"><input value={f.title} onChange={set("title")} placeholder="Filtrer" className={cellInput} /></th>
              <th className="px-2 pb-2 pt-1" colSpan={2}><input value={f.party} onChange={set("party")} placeholder="Expéditeur ou destinataire" className={cellInput} /></th>
              {/* Départ et Arrivée se filtrent AU MOIS ; l'Accusé par présence — les trois
                  questions qu'on pose vraiment au carnet. */}
              <th className="px-2 pb-2 pt-1"><input type="month" value={f.sentMonth} onChange={set("sentMonth")} title="Mois de départ" className={cellInput} /></th>
              <th className="px-2 pb-2 pt-1"><input type="month" value={f.receivedMonth} onChange={set("receivedMonth")} title="Mois d'arrivée" className={cellInput} /></th>
              <th className="px-2 pb-2 pt-1">
                <select value={f.ack} onChange={set("ack")} className={cellInput}>
                  <option value="">Tous</option>
                  <option value="with">Avec accusé</option>
                  <option value="without">Sans accusé</option>
                </select>
              </th>
              <th className="px-2 pb-2 pt-1"><input value={f.concerns} onChange={set("concerns")} placeholder="Direction ou personne" className={cellInput} /></th>
              {/* Entité · Partenaire · Porteur · Pièces — quatre colonnes sans filtre propre. */}
              <th className="px-2 pb-2 pt-1" colSpan={4} />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.length === 0 ? (
              <tr><td colSpan={13} className="px-3 py-8 text-center text-sm text-muted-foreground">Aucun courrier ne correspond à ces filtres.</td></tr>
            ) : shown.map((r) => {
              const dir = MAIL_DIRECTION[r.direction];
              return (
                <tr key={r.id} className="hover:bg-secondary/30">
                  <td className="sticky left-0 z-10 bg-card px-3 py-2 font-mono text-xs text-muted-foreground">{r.reference || "—"}</td>
                  <td className="px-3 py-2"><Badge tone={dir?.tone ?? "neutral"} dot={false}>{dir?.label ?? r.direction}</Badge></td>
                  <td className="px-3 py-2 font-medium">
                    <Link href={`/courriers/${r.id}`} className="hover:underline">{r.title}</Link>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{r.sender || "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.recipient || "—"}</td>
                  {/* Le départ garde son HEURE : deux plis du même jour ne partent pas ensemble. */}
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">{r.sentAt ? formatDateTime(r.sentAt) : "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><DateCell id={r.id} field="receivedAt" value={r.receivedAt} canEdit={canEdit} /></td>
                  <td className="px-3 py-2 whitespace-nowrap"><DateCell id={r.id} field="acknowledgedAt" value={r.acknowledgedAt} canEdit={canEdit} /></td>
                  {/* LA DIRECTION ET LA PERSONNE dans une seule colonne : elles répondent à la même
                      question (« qui devait traiter ce pli ? ») et se cumulent souvent — deux
                      colonnes à moitié vides côte à côte auraient élargi le tableau pour rien. */}
                  <td className="px-3 py-2 text-xs">
                    {r.departmentName || r.concernedName ? (
                      <span className="flex flex-col leading-tight">
                        {r.departmentName && <span className="text-foreground">{r.departmentName}</span>}
                        {r.concernedName && <span className="text-muted-foreground">{r.concernedName}</span>}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{r.companyName || "—"}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{r.partnerName || "—"}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{r.carrier || "—"}</td>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      {r.attachments > 0 ? (
                        <Link href={`/courriers/${r.id}`} title={`${r.attachments} pièce(s) jointe(s)`}
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                          <Paperclip className="h-3.5 w-3.5" /> {r.attachments}
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                      {/* Ouvert à QUI VOIT le pli, pas seulement à qui le modifie : « transmets ce
                          courrier à la Direction » est une lecture qu'on relaie, pas une écriture. */}
                      <PartagerButton
                        iconOnly variant="ghost"
                        refType="MAIL_ENTRY" refId={r.id}
                        refLabel={r.reference ? `${r.reference} — ${r.title}` : r.title}
                        href={`/courriers/${r.id}`}
                      />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
