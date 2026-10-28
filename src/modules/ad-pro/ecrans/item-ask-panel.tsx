"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileQuestion, ShieldCheck, Loader2, Check } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { requestDocument, askablePeople } from "@/lib/actions/document-request-actions";
import { pieceKindOptions, filingNotice } from "@/lib/legal/from-piece";
import { createValidationRequest } from "@/lib/actions/validation-actions";

/**
 * CE QU'ON DEMANDE À QUELQU'UN D'AUTRE, DEPUIS UN POSTE DE DÉPENSE.
 *
 * Deux gestes qui se ressemblent et qu'il ne faut pas confondre :
 *
 *   • **demander une PIÈCE** — la facture est chez le commercial, le devis chez l'assistante,
 *     l'attestation chez le comptable : la pièce qui manque n'est presque jamais chez celui qui
 *     en a besoin. On la réclamait par message, et l'on perdait la trace de ce qu'on attendait,
 *     de qui, depuis quand. La personne sollicitée dépose SANS avoir accès au module — le fil
 *     lui ouvre la seule chose qui la concerne ;
 *   • **demander une VALIDATION** — un avis, un accord. Chacun peut à son tour en redemander une
 *     à quelqu'un d'autre : c'est la même action, prise depuis l'écran des validations.
 *
 * L'annuaire est chargé À L'OUVERTURE, pas avec la page : un écran de poste de dépense n'a
 * aucune raison de transporter la liste de tout le monde pour un panneau que la plupart des
 * visites n'ouvriront pas.
 */
export function ItemAskPanel({
  entityType, entityId, link, subject, moduleLibelle, canAskValidation = true,
}: {
  /** L'objet auquel la pièce se rattachera (`AD_PRO_ITEM` pour un poste). */
  entityType: string;
  entityId: string;
  /** Retour vers l'écran d'origine — celui qui dépose n'y a pas forcément accès, celui qui demande si. */
  link: string;
  /** L'intitulé de l'objet, pour pré-remplir les titres. */
  subject: string;
  /**
   * LE MODULE QUE LIRA LE VALIDATEUR. Il était écrit « SPONSORING » en dur : une validation demandée
   * depuis le poste d'un congrès arrivait étiquetée sponsoring dans sa file (audit 360°, R24–R36).
   * `null` là où l'on ne demande pas de validation.
   */
  moduleLibelle: string | null;
  /**
   * DEMANDER UNE VALIDATION A-T-IL ENCORE UN SENS ICI ?
   *
   * Sur un poste de dépense en cours d'arbitrage, oui. Sur un paiement DÉJÀ AUTORISÉ par le centre
   * — la file du décaissement, le centre lui-même — non : faire valider ce qui vient d'être validé
   * ne mène nulle part, et proposer un geste sans effet est pire que ne rien proposer. On l'exerce,
   * on attend une réponse, elle ne vient jamais.
   */
  canAskValidation?: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = React.useState<"piece" | "validation" | null>(null);
  const [people, setPeople] = React.useState<{ id: string; name: string }[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<{ href: string; text: string } | null>(null);

  const [label, setLabel] = React.useState("");
  const [kind, setKind] = React.useState("INVOICE");
  const [who, setWho] = React.useState("");
  const [who2, setWho2] = React.useState("");
  const [due, setDue] = React.useState("");
  const [note, setNote] = React.useState("");

  const open = async (m: "piece" | "validation") => {
    setMode(m); setErr(null); setDone(null);
    setLabel(""); setKind("INVOICE"); setWho(""); setWho2(""); setDue(""); setNote("");
    if (people === null) setPeople(await askablePeople());
  };

  const submitPiece = async () => {
    setBusy(true); setErr(null);
    const fd = new FormData();
    fd.set("entityType", entityType);
    fd.set("entityId", entityId);
    fd.set("link", link);
    fd.set("label", label);
    fd.set("kind", kind);
    fd.set("askedToId", who);
    fd.set("dueDate", due);
    fd.set("note", note);
    const r = await requestDocument(fd);
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? "La demande n'a pas pu être créée."); return; }
    setDone({ href: `/pieces/${r.id}`, text: "Demande envoyée — la personne est prévenue." });
    router.refresh();
  };

  const submitValidation = async () => {
    setBusy(true); setErr(null);
    const fd = new FormData();
    fd.set("title", label || `Validation — ${subject}`);
    fd.set("description", note);
    fd.set("link", link);
    fd.set("module", moduleLibelle ?? "Ad & Pro");
    fd.set("validator1Id", who);
    if (who2) fd.set("validator2Id", who2);
    if (due) fd.set("deadline", due);
    const r = await createValidationRequest(undefined, fd);
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? "La demande n'a pas pu être créée."); return; }
    setDone({ href: "/validations", text: "Validation demandée — le validateur est prévenu." });
    router.refresh();
  };

  const loading = people === null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button" onClick={() => void open("piece")}
          className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-border bg-background px-3 py-1.5 font-medium hover:bg-secondary sm:min-h-0 sm:px-2 sm:py-1"
        >
          <FileQuestion className="h-3.5 w-3.5" /> Demander une pièce
        </button>
        {canAskValidation && (
        <button
          type="button" onClick={() => void open("validation")}
          className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-border bg-background px-3 py-1.5 font-medium hover:bg-secondary sm:min-h-0 sm:px-2 sm:py-1"
        >
          <ShieldCheck className="h-3.5 w-3.5" /> Demander une validation
        </button>
        )}
      </div>

      <Sheet
        open={mode !== null}
        onClose={() => setMode(null)}
        title={mode === "validation" ? "Demander une validation" : "Demander une pièce"}
        description={mode === "validation"
          ? "Choisissez qui doit se prononcer. Chaque validateur pourra, à son tour, en demander une autre."
          : "La personne sollicitée déposera la pièce sans avoir accès à ce module — le fil ne lui ouvre que ce qui la concerne."}
        width="md"
      >
        {done ? (
          <div className="space-y-3">
            <p className="flex items-center gap-2 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
              <Check className="h-4 w-4 shrink-0" /> {done.text}
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" className="w-full sm:w-auto" onClick={() => setMode(null)}>Fermer</Button>
              <Link href={done.href} className="inline-flex min-h-10 w-full items-center justify-center rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:w-auto">
                Voir la demande
              </Link>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ask-label">{mode === "validation" ? "Objet de la validation" : "Pièce demandée"}</Label>
              <Input
                id="ask-label" value={label} onChange={(e) => setLabel(e.target.value)}
                placeholder={mode === "validation" ? `Validation — ${subject}` : "Ex. la facture définitive de l'agence"}
              />
              {mode === "piece" && (
                // « Pièce n° 3 » n'apprend rien à celui qui doit la chercher dans ses dossiers.
                <p className="text-xs text-muted-foreground">Dites CE QUE vous demandez, en clair — c&apos;est ce que la personne lira.</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ask-who">{mode === "validation" ? "Validateur" : "À qui"}</Label>
              <Select id="ask-who" value={who} onChange={(e) => setWho(e.target.value)} disabled={loading}>
                <option value="">{loading ? "Chargement…" : "— Choisir une personne —"}</option>
                {(people ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </div>

            {mode === "validation" && (
              <div className="space-y-1.5">
                <Label htmlFor="ask-who2">Second validateur (facultatif)</Label>
                <Select id="ask-who2" value={who2} onChange={(e) => setWho2(e.target.value)} disabled={loading}>
                  <option value="">— Aucun —</option>
                  {(people ?? []).filter((p) => p.id !== who).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              </div>
            )}

            {mode === "piece" && (
              // LA NATURE DE LA PIÈCE, et ce qu'elle entraîne — dit AVANT l'envoi. Une facture ou
              // un bon de commande acceptés rejoignent le registre des engagements (Legal).
              <div className="space-y-1.5">
                <Label htmlFor="ask-kind">Nature de la pièce</Label>
                <Select id="ask-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                  {pieceKindOptions().map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
                {filingNotice(kind) && <p className="text-xs text-muted-foreground">{filingNotice(kind)}</p>}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="ask-due">{mode === "validation" ? "Échéance" : "Attendue pour"}</Label>
              <Input id="ask-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ask-note">Précisions</Label>
              <Textarea id="ask-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
            </div>

            {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

            <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
              <Button variant="outline" className="w-full sm:w-auto" onClick={() => setMode(null)}>Annuler</Button>
              <Button
                className="w-full sm:w-auto"
                disabled={busy || !who || (mode === "piece" && !label.trim())}
                onClick={() => void (mode === "validation" ? submitValidation() : submitPiece())}
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Envoyer
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </>
  );
}
