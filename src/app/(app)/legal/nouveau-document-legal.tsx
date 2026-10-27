"use client";

import * as React from "react";
import { Plus, Loader2, Sparkles, UploadCloud, FolderSearch, FileText, AlertCircle, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { RecordForm, type FieldDef } from "@/components/shared/create-record-button";
import { DriveExplorerSheet, type DrivePickerValue } from "@/components/drive/drive-picker";
import { lireDocumentLegalPourSaisie } from "@/lib/actions/legal-lecture-actions";
import type { LectureDocumentLegal } from "@/lib/pieces-lues/document-legal";
import { ACCEPT_PIECES, PAGES_MAX, TAILLE_MAX_OCTETS } from "@/lib/pieces-lues/formats";
import type { ActionResult } from "@/lib/actions/types";
import { champsPreremplis, marquesAffichees, type Gardes } from "./champs-preremplis";
import { cn } from "@/lib/utils";

/**
 * « NOUVEAU DOCUMENT » ET « NOUVELLE FACTURE » — LA PIÈCE D'ABORD, LE FORMULAIRE ENSUITE.
 *
 * On dépose le fichier (ou on le désigne dans le Drive) ; il est lu (`lireDocumentLegalPourSaisie`) ; le formulaire
 * s'ouvre avec ce que la pièce DIT, chaque champ rempli marqué et prouvé, le reste vide. Le fichier lu est déjà joint :
 * on ne le téléverse pas deux fois. Enregistrer reste le seul geste qui écrit — par `createLegalDocument`, inchangée,
 * avec toutes ses gardes.
 *
 * Trois choses se disent AVANT la lecture ou se gardent APRÈS :
 *   • « Document confidentiel » se coche avant de lire : ses lecteurs se choisissent dans le formulaire, qui s'ouvre
 *     après — et une pièce confidentielle ne doit rien envoyer à Luna, pas même le temps de la saisie ;
 *   • plusieurs fichiers : le premier est la pièce, les autres des annexes — « Lire plutôt celle-ci » change d'avis ;
 *   • changer de pièce RELIT, et ne remplace que les champs que la personne n'a pas touchés.
 */

type Etape = "fichier" | "lecture" | "saisie";

const fmtTaille = (n: number) => (n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} Mo` : `${Math.max(1, Math.ceil(n / 1024))} Ko`);

export function NouveauDocumentLegal({
  label, title, description, fields, action, redirectBase, facture,
}: {
  label: string;
  title: string;
  description?: string;
  fields: FieldDef[];
  action: (prev: ActionResult | undefined, formData: FormData) => Promise<ActionResult>;
  redirectBase?: string;
  /** Ouvert depuis « les factures » : la nature est donnée, pas lue. */
  facture: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [etape, setEtape] = React.useState<Etape>("fichier");
  const [confidentiel, setConfidentiel] = React.useState(false);
  const [fichiers, setFichiers] = React.useState<File[]>([]);
  const [lu, setLu] = React.useState(0);
  const [drive, setDrive] = React.useState<DrivePickerValue | null>(null);
  const [explorer, setExplorer] = React.useState(false);
  const [lecture, setLecture] = React.useState<LectureDocumentLegal | null>(null);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [gardes, setGardes] = React.useState<Gardes>({});
  const [version, setVersion] = React.useState(0);
  const [survol, setSurvol] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement>(null);
  const touches = React.useRef<Set<string>>(new Set());

  const reinitialiser = () => {
    setEtape("fichier"); setConfidentiel(false); setFichiers([]); setLu(0); setDrive(null); setLecture(null);
    setErreur(null); setGardes({}); touches.current = new Set();
  };
  const fermer = () => { setOpen(false); reinitialiser(); };

  /**
   * Ce que la personne a touché, relevé dans le formulaire AVANT d'en changer la pièce. Les listes (parties, lecteurs)
   * se relèvent en entier ; les fichiers ne se relèvent pas — la nouvelle pièce les remplace.
   */
  const releverGardes = (): Gardes => {
    const form = formRef.current;
    if (!form) return gardes;
    const fd = new FormData(form);
    const out: Gardes = { ...gardes };
    for (const name of touches.current) {
      const f = fields.find((x) => x.type !== "hidden" && x.name === name);
      if (!f || f.type === "file" || f.type === "drivepicker") continue;
      out[name] = f.type === "parties" || f.type === "multiselect" ? fd.getAll(name).map(String) : String(fd.get(name) ?? "");
    }
    return out;
  };

  async function lire(source: { fichier: File } | { drive: DrivePickerValue }) {
    setEtape("lecture"); setErreur(null);
    const fd = new FormData();
    if ("fichier" in source) fd.set("fichier", source.fichier);
    else fd.set("driveNodeId", source.drive.id);
    if (confidentiel) fd.set("confidentiel", "1");
    if (facture) fd.set("nature", "INVOICE");
    let r: Awaited<ReturnType<typeof lireDocumentLegalPourSaisie>>;
    try {
      r = await lireDocumentLegalPourSaisie(fd);
    } catch {
      r = { ok: false, error: "La lecture n'a pas abouti (connexion ou serveur)." };
    }
    // UNE PIÈCE ILLISIBLE N'EMPÊCHE PAS DE SAISIR : le formulaire s'ouvre, vide, la pièce jointe, et la raison dite.
    setLecture(r.ok ? r.lecture : null);
    setErreur(r.ok ? null : r.error);
    setVersion((v) => v + 1);
    setEtape("saisie");
  }

  function choisirFichiers(liste: FileList | File[] | null) {
    const tous = Array.from(liste ?? []).filter((f) => f.size > 0);
    if (tous.length === 0) return;
    setGardes(releverGardes());
    setFichiers(tous); setLu(0); setDrive(null);
    void lire({ fichier: tous[0] });
  }

  function choisirDrive(v: DrivePickerValue) {
    setExplorer(false);
    setGardes(releverGardes());
    setDrive(v); setFichiers([]); setLu(0);
    if (v.isFolder) {
      // UN DOSSIER SE RÉFÉRENCE, il ne se lit pas : le formulaire s'ouvre, le lien posé.
      setLecture(null); setErreur(null); setVersion((x) => x + 1); setEtape("saisie");
      return;
    }
    void lire({ drive: v });
  }

  function lirePlutot(i: number) {
    setGardes(releverGardes());
    setLu(i);
    void lire({ fichier: fichiers[i] });
  }

  function changerDePiece() {
    setGardes(releverGardes());
    setEtape("fichier");
  }

  const sansFichier = () => { setLecture(null); setErreur(null); setFichiers([]); setDrive(null); setVersion((v) => v + 1); setEtape("saisie"); };

  const p = lecture?.prerempli ?? null;
  const champs = champsPreremplis(fields, p, gardes, confidentiel);
  const marques = marquesAffichees(p, gardes);
  const remplis = Object.keys(marques).length;
  const nomLu = drive && !drive.isFolder ? drive.name : fichiers[lu]?.name ?? null;

  const entete = etape === "saisie" && (nomLu || drive) ? (
    <div className={cn("mb-4 space-y-2 rounded-lg border p-3 text-sm", lecture ? "border-luna/30 bg-luna-soft" : "border-border bg-secondary/40")}>
      {lecture ? (
        <p className="flex items-start gap-1.5">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-luna" />
          <span>
            <strong className="font-medium">{lecture.phrase}</strong>{" "}
            {remplis > 0
              ? `${remplis} champ${remplis > 1 ? "s" : ""} rempli${remplis > 1 ? "s" : ""} depuis la pièce — vérifiez-les avant d'enregistrer ; les autres sont à compléter.`
              : "Rien n'a pu être repris de la pièce : complétez le formulaire."}
          </span>
        </p>
      ) : erreur ? (
        <p className="flex items-start gap-1.5 text-foreground">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>La pièce n&apos;a pas pu être lue : {erreur} Elle reste jointe ; complétez le formulaire.</span>
        </p>
      ) : drive?.isFolder ? (
        <p className="text-muted-foreground">Un dossier du Drive se référence, il ne se lit pas : complétez le formulaire.</p>
      ) : null}
      {p?.montantConflit && <p className="text-xs text-warning">{p.montantConflit}</p>}
      {lecture?.coupe && <p className="text-xs text-muted-foreground">{lecture.coupe}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {fichiers.map((f, i) => (
          <span key={`${f.name}-${i}`} className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs">
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{f.name}</span>
            {i === lu
              ? <span className="shrink-0 text-muted-foreground">· lue, jointe</span>
              : <button type="button" onClick={() => lirePlutot(i)} className="shrink-0 text-primary underline-offset-2 hover:underline">Lire plutôt celle-ci</button>}
          </span>
        ))}
        {drive && (
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs">
            <FolderSearch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{drive.name}</span>
            <span className="shrink-0 text-muted-foreground">· Drive, référencé</span>
          </span>
        )}
        <Button type="button" size="sm" variant="outline" onClick={changerDePiece}>Changer de pièce</Button>
      </div>
    </div>
  ) : null;

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        {label}
      </Button>

      <Sheet open={open} onClose={() => etape !== "lecture" && fermer()} title={title} description={description} width="lg">
        {etape === "fichier" && (
          <div className="space-y-4">
            <label
              htmlFor="nouveau-doc-piece"
              onDragOver={(e) => { e.preventDefault(); setSurvol(true); }}
              onDragLeave={() => setSurvol(false)}
              onDrop={(e) => { e.preventDefault(); setSurvol(false); choisirFichiers(e.dataTransfer.files); }}
              className={cn(
                "flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-10 text-center transition-colors",
                survol ? "border-luna bg-luna-soft" : "border-luna/30 bg-luna-soft/60 hover:border-luna/60",
              )}
            >
              <UploadCloud className="h-7 w-7 text-luna" />
              <span className="text-sm font-medium">Déposez la pièce ici, ou cliquez pour la choisir</span>
              <span className="text-xs text-muted-foreground">Le formulaire se remplira avec ce qu&apos;elle contient. Vous pourrez tout corriger.</span>
              <span className="text-xs text-muted-foreground">PDF, scan ou photo, Word, Excel · {fmtTaille(TAILLE_MAX_OCTETS)} et {PAGES_MAX} pages lues au plus</span>
              <input
                id="nouveau-doc-piece" type="file" multiple accept={ACCEPT_PIECES} className="sr-only"
                onChange={(e) => choisirFichiers(e.target.files)}
              />
            </label>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button type="button" variant="outline" onClick={() => setExplorer(true)}>
                <FolderSearch className="h-4 w-4" /> …ou un fichier du Drive
              </Button>
              <button type="button" onClick={sansFichier} className="text-sm text-primary underline-offset-2 hover:underline">
                Saisir sans fichier
              </button>
            </div>

            <label htmlFor="nouveau-doc-confidentiel" className="flex items-start gap-2.5 rounded-lg border border-border p-3 text-sm">
              <input
                id="nouveau-doc-confidentiel" type="checkbox" checked={confidentiel}
                onChange={(e) => setConfidentiel(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-input"
              />
              <span>
                <span className="flex items-center gap-1.5 font-medium"><Lock className="h-3.5 w-3.5" /> Document confidentiel</span>
                <span className="block text-xs text-muted-foreground">
                  Lecture locale seulement : rien n&apos;est envoyé à Luna. Vous choisirez ses lecteurs à l&apos;étape suivante.
                </span>
              </span>
            </label>

            {explorer && <DriveExplorerSheet onClose={() => setExplorer(false)} onPick={choisirDrive} />}
          </div>
        )}

        {etape === "lecture" && (
          <div className="flex flex-col items-center gap-3 py-12 text-center" role="status">
            <Loader2 className="h-6 w-6 animate-spin text-luna" />
            <p className="text-sm font-medium">Lecture de « {nomLu ?? "la pièce"} »…</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {confidentiel
                ? "Lecture locale : texte, en-tête, montants et identifiants. Rien n'est envoyé à Luna."
                : "Texte, en-tête, montants et identifiants, puis nature, titre et résumé par Luna quand la lecture des pièces est ouverte. Une pièce déjà lue s'ouvre tout de suite."}
            </p>
          </div>
        )}

        {etape === "saisie" && (
          <RecordForm
            key={version}
            fields={champs}
            action={action}
            redirectBase={redirectBase}
            marques={marques}
            // LA PIÈCE LUE EN PREMIER : la garde des factures en double compare la première pièce jointe.
            fichiersInitiaux={fichiers.length > 0 ? { attachment: [fichiers[lu], ...fichiers.filter((_, i) => i !== lu)] } : undefined}
            drivesInitiaux={drive ? { driveNodeId: drive } : undefined}
            entete={entete}
            formRef={formRef}
            onTouched={(name) => { touches.current.add(name); }}
            onDone={fermer}
            onCancel={fermer}
          />
        )}
      </Sheet>
    </>
  );
}
