"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Banknote, Plus, Loader2, X, Paperclip, Info, Library, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { PAYMENT_PIECE_KIND_OPTIONS, PAYMENT_URGENCY_OPTIONS } from "@/lib/labels";
import {
  aRemplir, DEADLINE_NATURE_OPTIONS, dossierHint, pieceQuiRemplit, type ChampRempli, type DocumentLegalPropose, type LecturePourDemande,
} from "@/modules/finances/partage";
import { createPaymentRequest } from "@/modules/finances/actions-demandes";
import { lirePieceDePaiement } from "@/modules/finances/actions-pieces-paiement";
import { ChoisirDansLegal } from "./choisir-dans-legal";
import { actionFailureMessage } from "@/lib/action-outcome";
import { FactureDejaConnueCarte } from "@/components/factures/facture-deja-connue";
import { EcartMontantCarte } from "@/components/finance/ecart-montant";
import type { FactureDejaConnue } from "@/lib/factures/blocage-vue";

interface PieceDraft { cle: string; file: File; kind: string; note: string; kindTouche: boolean }
interface PieceLegale { doc: DocumentLegalPropose; note: string }
/** La lecture d'une pièce, le temps qu'elle se fasse, puis ce qu'elle propose (`lirePieceDePaiement`). */
type EtatLecture = { etat: "lecture" } | { etat: "echec"; message: string } | (Extract<LecturePourDemande, { ok: true }> & { etat: "lue"; libelle: string });
const cleLegale = (id: string) => `l:${id}`;
let compteur = 0;

/** « Lu sur … — vérifiez » : le champ a été rempli par une pièce, pas par la personne. */
function LuSur({ source }: { source: string | undefined }) {
  return source ? <p className="text-xs text-luna">Lu sur « {source} » — vérifiez.</p> : null;
}

/**
 * DEMANDER UN PAIEMENT — le dossier se constitue ICI, pièce par pièce.
 *
 * Un formulaire qui se contenterait d'un champ « pièces jointes (multiple) » perdrait ce qui fait
 * la valeur du dossier : **le commentaire attaché à CHAQUE pièce**. « Voici la facture, le montant
 * TTC inclut la livraison » appelle une réponse sur cette facture-là — pas un message général que
 * les Finances devront rattacher de tête, puis rechercher trois semaines plus tard.
 *
 * ── CE QUE LE DOSSIER DOIT PORTER ────────────────────────────────────────────────────────────
 *
 * Un **bon de commande, une facture OU un devis** — les pièces qui disent ce que la société doit,
 * à qui et pour combien — et la **déclaration que le moyen de paiement y figure**. Le reste (bon
 * de livraison, notes, contact) est facultatif, et c'est délibéré : rendre obligatoire ce qui n'est
 * pas toujours pertinent apprend à remplir les champs pour rien.
 *
 * La règle est annoncée PENDANT la saisie (`dossierHint`), pas découverte dans une erreur rouge
 * après avoir tout rempli. C'est la même fonction que celle qui garde l'action serveur : deux
 * règles séparées auraient divergé.
 *
 * L'échéance a trois formes, et les trois comptent : la **date convenue**, **ce qu'elle pèse**
 * (fixe non négociable, importante, moyenne), et à défaut de date **l'urgence**.
 *
 * ── LE FORMULAIRE SE REMPLIT DEPUIS LA PIÈCE (Direction, 04/11/2026) ─────────────────────────
 *
 * Une pièce se CHOISIT DANS LEGAL (`ChoisirDansLegal`) ou se dépose ; chacune est lue (`lirePieceDePaiement`) et
 * la meilleure — la facture, sinon le BC, sinon le devis — remplit l'objet, le bénéficiaire, le montant, l'échéance et
 * le contact (`pieceQuiRemplit`). Un champ que la personne a TOUCHÉ n'est jamais réécrit (`aRemplir`) ; un champ
 * rempli le dit (« Lu sur … — vérifiez »). Un RIB lu coche l'attestation du moyen de paiement, que la personne confirme.
 */
export function NewPaymentButton() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [connue, setConnue] = React.useState<FactureDejaConnue | null>(null);
  const [pieces, setPieces] = React.useState<PieceDraft[]>([]);
  const [methodStated, setMethodStated] = React.useState(false);
  // LE MONTANT FACE À LA FACTURE (`finance/montant-facture.ts`) : l'écart que l'action a refusé, et sa réponse.
  const [ecart, setEcart] = React.useState<{ montant: number; total: number } | null>(null);
  const [justification, setJustification] = React.useState("");
  const [confirme, setConfirme] = React.useState(false);
  const [legaux, setLegaux] = React.useState<PieceLegale[]>([]);
  const [choisir, setChoisir] = React.useState(false);
  const [lectures, setLectures] = React.useState<Record<string, EtatLecture>>({});
  const [remplis, setRemplis] = React.useState<Partial<Record<ChampRempli, string>>>({});
  const [ribNote, setRibNote] = React.useState<string | null>(null);
  const touches = React.useRef<Set<string>>(new Set());
  const methodTouche = React.useRef(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const formRef = React.useRef<HTMLFormElement>(null);

  const reset = () => {
    setPieces([]); setMethodStated(false); setErr(null); setConnue(null); setEcart(null); setJustification(""); setConfirme(false);
    setLegaux([]); setChoisir(false); setLectures({}); setRemplis({}); setRibNote(null);
    touches.current = new Set(); methodTouche.current = false;
  };

  /** Lire une pièce ; le résultat d'une pièce retirée entre-temps est ignoré. */
  const lire = async (cle: string, libelle: string, fd: FormData) => {
    setLectures((l) => ({ ...l, [cle]: { etat: "lecture" } }));
    let etat: EtatLecture;
    try {
      const r = await lirePieceDePaiement(fd);
      etat = r.ok ? { ...r, etat: "lue", libelle } : { etat: "echec", message: r.error };
      // LA NATURE LUE devient celle de la pièce déposée, tant que la personne ne l'a pas choisie elle-même.
      if (r.ok && r.nature) setPieces((prev) => prev.map((x) => (x.cle === cle && !x.kindTouche ? { ...x, kind: r.nature! } : x)));
    } catch {
      etat = { etat: "echec", message: "Lecture impossible : remplissez le formulaire à la main." };
    }
    setLectures((l) => (cle in l ? { ...l, [cle]: etat } : l));
  };
  const oublier = (cle: string) => setLectures((l) => { const n = { ...l }; delete n[cle]; return n; });

  // LA MEILLEURE PIÈCE LUE REMPLIT LE FORMULAIRE — jamais un champ touché ; une facture arrivée après un devis le remplace.
  React.useEffect(() => {
    const lues = [
      ...pieces.map((p) => ({ cle: p.cle, nature: p.kind })),
      ...legaux.map((l) => ({ cle: cleLegale(l.doc.id), nature: l.doc.nature as string })),
    ].flatMap((x) => { const lu = lectures[x.cle]; return lu?.etat === "lue" ? [{ ...x, lu }] : []; });
    const meilleure = pieceQuiRemplit(lues);
    const form = formRef.current;
    if (!meilleure || !form) return;
    const poser = aRemplir(meilleure.lu.proposition, touches.current);
    for (const [champ, valeur] of Object.entries(poser)) {
      const el = form.elements.namedItem(champ);
      if (el instanceof HTMLInputElement) el.value = valeur;
    }
    setRemplis((prev) => {
      const n = { ...prev };
      for (const c of Object.keys(poser) as ChampRempli[]) n[c] = meilleure.lu.libelle;
      return n;
    });
    if (meilleure.lu.ribLu && !methodTouche.current) {
      setMethodStated(true);
      setRibNote(`RIB lu sur « ${meilleure.lu.libelle} » : confirmez que le moyen de paiement y figure.`);
    }
  }, [lectures, pieces, legaux]);

  const choisirLegal = (doc: DocumentLegalPropose) => {
    setLegaux((prev) => (prev.some((l) => l.doc.id === doc.id) ? prev : [...prev, { doc, note: "" }]));
    setChoisir(false);
    const fd = new FormData();
    fd.set("legalDocumentId", doc.id);
    void lire(cleLegale(doc.id), doc.titre, fd);
  };

  const prendreMontantFacture = () => {
    const champ = formRef.current?.elements.namedItem("amount");
    if (ecart && champ instanceof HTMLInputElement) champ.value = String(ecart.total);
    setEcart(null); setJustification(""); setConfirme(false);
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    // ── LE FICHIER SE LIT AVANT, JAMAIS DANS L'UPDATER ────────────────────────────────────────
    //
    // `setPieces((prev) => [...prev, ...Array.from(list)…])` paraît identique et ne l'est pas :
    // le corps de la fonction n'est exécuté que LORSQUE React traite la mise à jour — c'est-à-dire
    // APRÈS la ligne suivante, qui remet l'input à vide. Or vider un `<input type="file">` VIDE SA
    // FileList : `list` est alors une liste vide, et l'on ajoutait zéro pièce.
    //
    // D'où le défaut rapporté : on joignait bien une pièce, et l'envoi répondait quand même
    // « Joignez au moins une pièce ». Le comportement dépendait du moment où React traitait la
    // mise à jour — donc intermittent, donc incompréhensible.
    //
    // On matérialise le tableau MAINTENANT ; l'updater ne fait plus que concaténer.
    const ajoutees = Array.from(list).map((file) => ({ cle: `f:${++compteur}`, file, kind: "INVOICE", note: "", kindTouche: false }));
    if (ajoutees.length === 0) return;
    setPieces((prev) => [...prev, ...ajoutees]);
    if (fileRef.current) fileRef.current.value = "";
    // CHAQUE PIÈCE EST LUE à son arrivée — ce qu'elle dit remplit le formulaire.
    for (const a of ajoutees) {
      const fd = new FormData();
      fd.set("fichier", a.file);
      void lire(a.cle, a.file.name, fd);
    }
  };

  const patch = (i: number, p: Partial<PieceDraft>) =>
    setPieces((prev) => prev.map((x, j) => (j === i ? { ...x, ...p } : x)));

  // LA MÊME RÈGLE QUE LE SERVEUR, dite avant qu'on essaie. `entityType: null` : ce formulaire ne
  // crée jamais de bon de versement — celui-ci naît de l'Information médicale, avec son exemption.
  const manque = dossierHint({ entityType: null, pieces: [...pieces, ...legaux.map((l) => ({ kind: l.doc.nature }))], paymentMethodStated: methodStated });

  const submit = async (draft: boolean) => {
    const form = formRef.current;
    if (!form) return;
    setBusy(true); setErr(null); setConnue(null);
    const fd = new FormData(form);
    fd.set("submit", draft ? "0" : "1");
    fd.set("paymentMethodStated", methodStated ? "1" : "0");
    // Chaque pièce voyage avec SON commentaire et SA nature, à l'index correspondant.
    for (const [i, p] of pieces.entries()) {
      fd.append("files", p.file);
      fd.set(`kind_${i}`, p.kind);
      fd.set(`note_${i}`, p.note);
    }
    // Les documents CHOISIS DANS LEGAL : référencés, revérifiés par le serveur.
    for (const l of legaux) {
      fd.append("legalDocumentIds", l.doc.id);
      fd.set(`legalNote_${l.doc.id}`, l.note);
    }
    try {
      const r = await createPaymentRequest(undefined, fd);
      if (!r.ok) {
        if (r.factureConnue) setConnue(r.factureConnue);
        else if (r.ecartMontant) { setEcart(r.ecartMontant); if (justification.trim()) setErr(r.error ?? null); }
        else setErr(r.error ?? "La demande n'a pas pu être créée.");
        return;
      }
      setOpen(false); reset();
      router.push(`/validations/paiements/${r.id}`);
    } catch {
      // Le message de secours ne dit jamais « réessayez » : la demande a pu partir malgré la levée.
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outline" onClick={() => { reset(); setOpen(true); }}>
        <Banknote className="h-4 w-4" /> Demander un paiement
      </Button>
      <Sheet
        open={open}
        onClose={() => !busy && setOpen(false)}
        title="Demander un paiement"
        description="Le dossier part au CENTRE DE PAIEMENT — il n'y a pas de destinataire à choisir : c'est le centre qui autorise, avant que les Finances ne voient quoi que ce soit. Montant, bénéficiaire, échéance demandée, et le bon de commande, la facture ou le devis qui le justifie."
        width="lg"
      >
        <form
          ref={formRef} className="space-y-4" onSubmit={(e) => e.preventDefault()}
          // UN CHAMP TOUCHÉ EST À LA PERSONNE : aucune pièce ne le réécrit, et il ne se dit plus « lu ».
          onInput={(e) => {
            const nom = (e.target as HTMLInputElement).name;
            if (!nom) return;
            touches.current.add(nom);
            setRemplis((r) => { if (!(nom in r)) return r; const n = { ...r }; delete n[nom as ChampRempli]; return n; });
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="pay-title">Objet du paiement <span className="text-destructive">*</span></Label>
              <Input id="pay-title" name="title" required placeholder="Ex. Facture agence — brochure Cardiomax" />
              <LuSur source={remplis.title} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-payee">Bénéficiaire <span className="text-destructive">*</span></Label>
              <Input id="pay-payee" name="payee" required placeholder="À qui l'argent doit aller" />
              <LuSur source={remplis.payee} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-amount">Montant (DZD) <span className="text-destructive">*</span></Label>
              <Input id="pay-amount" name="amount" type="number" inputMode="decimal" step="any" required />
              <LuSur source={remplis.amount} />
            </div>
            {/* PLUS DE DESTINATAIRE — la demande va AU CENTRE DE PAIEMENT.
                Choisir une personne aux Finances n'avait plus de sens depuis que le centre est le
                guichet unique : les Finances ne voient rien avant l'autorisation, si bien que le
                champ désignait quelqu'un qui ne pouvait pas encore agir. Et une demande adressée
                à un absent dormait jusqu'à son retour. */}
            {/* PLUS DE CHOIX D'ENTITÉ (Direction, 06/10) : la demande d'un salarié est rattachée
                d'office à Adventum par le serveur (`createPaymentRequest`). La Direction peut
                toujours corriger l'entité en validant. */}
            <div className="space-y-1.5">
              <Label htmlFor="pay-due">Échéance demandée</Label>
              <Input id="pay-due" name="dueDate" type="date" />
              <LuSur source={remplis.dueDate} />
              {/* C'est un SOUHAIT, formé sans voir la trésorerie ni les autres engagements du
                  mois. Le centre de paiement voit la file entière et pose, en autorisant, la
                  date que la comptabilité devra tenir. Dire « demandée » évite de la croire
                  acquise. */}
              <p className="text-xs text-muted-foreground">Le centre de paiement arbitre : il voit la file entière.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-nature">Cette échéance est…</Label>
              <Select id="pay-nature" name="deadlineNature" defaultValue="MODERATE">
                {DEADLINE_NATURE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
              {/* Deux dates identiques ne pèsent pas la même chose. La nature CLASSE la file, et
                  une échéance fixe ne se reporte pas sans motif écrit — c'est le seul moyen que
                  ce que vous avez engagé auprès du bénéficiaire arrive jusqu'à la caisse. */}
              <p className="text-xs text-muted-foreground">Une échéance fixe ne se reporte pas sans motif écrit.</p>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="pay-urgency">…ou, à défaut de date, l&apos;urgence</Label>
              <Select id="pay-urgency" name="urgency" defaultValue="WHEN_POSSIBLE">
                {PAYMENT_URGENCY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="pay-desc">Contexte</Label>
              <Textarea id="pay-desc" name="description" rows={3} placeholder="Ce qui a été convenu, avec qui, et pourquoi ce montant." />
            </div>
          </div>

          {/* LE CONTACT — facultatif, et utile précisément quand quelque chose coince : une pièce
              manque, un virement n'arrive pas, un RIB a changé. Sans lui, on cherche dans les
              mails de quelqu'un qui est en congé. */}
          <div className="space-y-2 rounded-xl border border-border p-3">
            <Label>Contact chez le bénéficiaire <span className="text-xs font-normal text-muted-foreground">— facultatif</span></Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Input name="contactName" placeholder="Nom" autoComplete="off" />
              <Input name="contactPhone" type="tel" inputMode="tel" placeholder="Téléphone" autoComplete="off" />
              <Input name="contactEmail" type="email" inputMode="email" placeholder="E-mail" autoComplete="off" />
            </div>
            <LuSur source={remplis.contactPhone ?? remplis.contactEmail} />
            <p className="text-xs text-muted-foreground">Celui qu&apos;on appelle si une pièce manque ou si le virement n&apos;arrive pas.</p>
          </div>

          <div className="space-y-2 rounded-xl border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>Pièces du dossier</Label>
              <input
                ref={fileRef} type="file" multiple className="hidden"
                onChange={(e) => addFiles(e.target.files)}
              />
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => setChoisir((v) => !v)} aria-expanded={choisir}>
                  <Library className="h-4 w-4" /> Choisir dans Legal
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                  <Plus className="h-4 w-4" /> Ajouter des pièces
                </Button>
              </div>
            </div>
            {choisir && <ChoisirDansLegal dejaChoisis={legaux.map((l) => l.doc.id)} onChoisir={choisirLegal} />}
            <p className="text-xs text-muted-foreground">
              <strong className="text-foreground">Un bon de commande, une facture ou un devis est obligatoire</strong> —
              c&apos;est la pièce qui dit ce qui est dû. Bon de livraison et autres pièces s&apos;ajoutent librement, et
              <strong className="text-foreground"> chacune porte son propre commentaire</strong>.
            </p>

            {pieces.length === 0 && legaux.length === 0 ? (
              <p className="rounded-lg border border-dashed border-warning/50 bg-warning/5 px-3 py-4 text-center text-xs text-muted-foreground">
                Aucune pièce pour l&apos;instant. Vous pouvez enregistrer un <strong className="text-foreground">brouillon</strong> sans
                pièce et la joindre ensuite — l&apos;envoi, lui, exige le bon de commande, la facture ou le devis.
              </p>
            ) : (
              <ul className="space-y-2">
                {legaux.map((l) => (
                  <li key={l.doc.id} className="space-y-2 rounded-lg border border-border bg-secondary/20 p-2.5">
                    <div className="flex items-center gap-2">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{l.doc.titre}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">Legal</span>
                      <button
                        type="button" aria-label="Retirer"
                        onClick={() => { setLegaux((prev) => prev.filter((x) => x.doc.id !== l.doc.id)); oublier(cleLegale(l.doc.id)); }}
                        className="rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <EtatDeLecture etat={lectures[cleLegale(l.doc.id)]} />
                    {l.doc.avertissement && <p className="text-xs text-warning">{l.doc.avertissement}</p>}
                    <Input
                      value={l.note}
                      onChange={(e) => setLegaux((prev) => prev.map((x) => (x.doc.id === l.doc.id ? { ...x, note: e.target.value } : x)))}
                      placeholder="Commentaire sur cette pièce (ex. le TTC inclut la livraison)"
                    />
                  </li>
                ))}
                {pieces.map((p, i) => (
                  <li key={p.cle} className="space-y-2 rounded-lg border border-border bg-secondary/20 p-2.5">
                    <div className="flex items-center gap-2">
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.file.name}</span>
                      <button
                        type="button" aria-label="Retirer"
                        onClick={() => { setPieces((prev) => prev.filter((_, j) => j !== i)); oublier(p.cle); }}
                        className="rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <EtatDeLecture etat={lectures[p.cle]} />
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <Select value={p.kind} onChange={(e) => patch(i, { kind: e.target.value, kindTouche: true })}>
                        {PAYMENT_PIECE_KIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </Select>
                      <Input
                        className="sm:col-span-2" value={p.note}
                        onChange={(e) => patch(i, { note: e.target.value })}
                        placeholder="Commentaire sur cette pièce (ex. le TTC inclut la livraison)"
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {/* L'ATTESTATION — elle engage celui qui a la pièce sous les yeux. Sans elle, la
                comptabilité sait quoi payer mais pas comment, et le dossier repart trois jours
                pour un RIB. */}
            <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-secondary/30 px-3 py-2.5 text-sm">
              <input
                type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                checked={methodStated} onChange={(e) => { methodTouche.current = true; setRibNote(null); setMethodStated(e.target.checked); }}
              />
              <span>
                <strong>Le moyen de paiement est mentionné dans le document</strong> (RIB, chèque, espèces).
                <span className="block text-xs text-muted-foreground">Obligatoire pour envoyer — c&apos;est ce qui permet à la comptabilité de payer sans vous rappeler.</span>
                {ribNote && <span className="block text-xs text-luna">{ribNote}</span>}
              </span>
            </label>
          </div>

          {/* LA RÈGLE SE DIT AVANT, PAS APRÈS. Le bouton partait, l'action refusait, et l'on
              découvrait l'exigence dans un message rouge après avoir tout saisi. Une contrainte
              qu'on n'apprend qu'en la heurtant se vit comme une panne. */}
          {manque && (
            <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" /> {manque}
            </p>
          )}
          {connue && <FactureDejaConnueCarte info={connue} />}
          {ecart && (
            <EcartMontantCarte
              ecart={ecart} disabled={busy}
              justification={justification} onJustification={setJustification}
              confirme={confirme} onConfirme={setConfirme}
              onPrendreFacture={prendreMontantFacture}
            />
          )}
          {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:flex-wrap sm:justify-end">
            <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={busy} onClick={() => setOpen(false)}>Annuler</Button>
            <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={busy} onClick={() => void submit(true)}>
              Enregistrer en brouillon
            </Button>
            <Button
              type="button"
              className="w-full sm:w-auto"
              disabled={busy || manque !== null}
              title={manque ?? undefined}
              onClick={() => void submit(false)}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Envoyer au centre de paiement
            </Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}

/** Où en est la lecture d'une pièce : en cours, ce qu'elle a dit, ou pourquoi elle n'a rien donné. */
function EtatDeLecture({ etat }: { etat: EtatLecture | undefined }) {
  if (!etat) return null;
  if (etat.etat === "lecture") return <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Lecture de la pièce…</p>;
  if (etat.etat === "echec") return <p className="text-xs text-muted-foreground">{etat.message}</p>;
  return <p className="text-xs text-muted-foreground">{etat.phrase}</p>;
}
