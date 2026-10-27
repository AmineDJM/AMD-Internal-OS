"use client";

import * as React from "react";
import { useAutoOpen } from "./use-auto-open";
import { useFormState } from "react-dom";
import { useRouter } from "next/navigation";
import { Plus, Loader2, AlertCircle, Wand2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { DrivePickerField, type DrivePickerValue } from "@/components/drive/drive-picker";
import { PartyPicker, type PartiesProposees } from "@/components/directory/party-picker";
import type { PartyOption, PartyArity } from "@/lib/contacts/parties";
import type { ActionResult } from "@/lib/actions/types";
import { cn } from "@/lib/utils";

/** Pré-remplissage IA optionnel : un fichier est analysé (OCR + IA) → valeurs de champs. */
export interface AnalyzePrefill {
  action: (formData: FormData) => Promise<{ ok: boolean; error?: string; values?: Record<string, string> }>;
  buttonLabel: string; // ex. « Analyser un contrat (IA) »
  title: string; // titre du bloc
  hint: string; // explication
  accept?: string; // types de fichiers acceptés
  disabled?: boolean; // IA indisponible
  disabledHint?: string; // message si désactivé
}

/**
 * UN CHAMP REMPLI DEPUIS LA PIÈCE — d'où vient sa valeur et ce qui la prouve (la ligne du document,
 * la phrase, ou le calcul). Le champ reste VIOLET (`--luna`) tant que la personne ne l'a pas touché :
 * ce qui est violet n'est pas encore une saisie de la personne. Touché, il redevient le sien.
 */
export interface MarqueDeChamp {
  source: "REGLES" | "LUNA" | "CALCUL";
  preuve: string;
  ou: string | null;
}

export type FieldDef =
  | {
      // `datetime-local` pour les champs qui portent une HEURE (départ d'un courrier) : taper
      // « 2026-08-17T14:30 » à la main dans un champ texte, personne ne le fait juste.
      type: "text" | "number" | "date" | "datetime-local";
      name: string;
      label: string;
      required?: boolean;
      placeholder?: string;
      defaultValue?: string | number;
      full?: boolean;
      /** Ce que le champ attend quand le libellé ne suffit pas — ou POURQUOI il est libre ici
       *  alors qu'il se choisit ailleurs (référentiel vide). */
      hint?: string;
      /** Le CLAVIER du téléphone (« email », « tel », « numeric »…) — sans la validation stricte d'un `type="email"`. */
      inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
      autoComplete?: string;
    }
  | {
      type: "textarea";
      name: string;
      label: string;
      required?: boolean;
      placeholder?: string;
      // Le même formulaire sert à CRÉER et à MODIFIER : sans valeur initiale, rouvrir une fiche
      // pour corriger une date effacerait les notes déjà saisies.
      defaultValue?: string;
      full?: boolean;
    }
  | {
      type: "select";
      name: string;
      label: string;
      options: { value: string; label: string }[];
      required?: boolean;
      defaultValue?: string;
      placeholder?: string;
      /** Ce que le choix ENTRAÎNE, quand ce n'est pas évident (ex. « assignée à quelqu'un
       *  d'autre » ouvre un circuit de demande). Une liste déroulante ne le dit pas d'elle-même. */
      hint?: string;
      full?: boolean;
    }
  // Valeur portée par le formulaire sans être saisie : le RATTACHEMENT à l'objet d'où l'on
  // crée la pièce (« cette facture vient de CETTE demande »). Ce n'est pas un secret — le
  // serveur revérifie ce qu'il en fait — c'est un contexte que l'utilisateur n'a pas à ressaisir.
  | { type: "hidden"; name: string; value: string }
  // `defaultChecked` : le même formulaire sert à MODIFIER — sans lui, rouvrir une fiche pour
  // corriger son nom décocherait en silence une case qui était cochée.
  /**
   * `temoin` : pose AVANT la case un champ caché du même nom (`value="off"`). Décochée, une case
   * n'envoie RIEN — sans témoin, décocher sur une fiche qui l'était ne change donc rien à l'envoi
   * (§118.172). Avec lui, l'action lit oui, non, ou rien du tout par `fdCase` ; un banc l'exige
   * (`temoins-cases.test.ts`) dans chaque module d'actions qu'importe le formulaire qui le déclare.
   */
  | { type: "checkbox"; name: string; label: string; full?: boolean; defaultChecked?: boolean; hint?: string; temoin?: boolean }
  | {
      type: "multiselect"; name: string; label: string; options: { value: string; label: string }[]; required?: boolean; hint?: string; full?: boolean; defaultValue?: string[]; searchPlaceholder?: string; emptyLabel?: string;
      /**
       * CE QUI N'EST PAS DANS LA LISTE (§118.175) — une case « non présent » qui ouvre une saisie
       * libre, envoyée sous `name`. Les noms saisis S'AJOUTENT aux cases cochées côté serveur, et
       * le champ obligatoire est satisfait par l'un OU l'autre : un médecin hors annuaire ne doit
       * pas bloquer la demande.
       */
      horsListe?: { name: string; label: string; placeholder?: string; defaultValue?: string };
    }
  | { type: "file"; name: string; label: string; multiple?: boolean; required?: boolean; hint?: string; defaultValue?: string | number; full?: boolean; /** Formats proposés par le sélecteur (`.pdf,.png`…) — le serveur revérifie TOUJOURS. */ accept?: string }
  // L'EXPLORATEUR DU DRIVE, ouvert par-dessus le formulaire : on désigne un dossier ou un
  // fichier qui existe déjà plutôt que d'en téléverser une copie. Le champ ne transporte qu'un
  // identifiant de nœud — le fichier, lui, ne bouge pas.
  | { type: "drivepicker"; name: string; label: string; hint?: string; full?: boolean }
  // LA PARTIE, CHOISIE DANS L'ANNUAIRE DE L'ENTREPRISE — et non plus tapée à la main.
  //
  // Une partie à un contrat, l'expéditeur d'un pli, son destinataire : trois champs de texte
  // libre où l'on écrivait trois orthographes du même prestataire, sans jamais un numéro. Ce
  // champ n'affiche que le NOM (une fiche n'a pas à porter un pavé de coordonnées) mais ce nom
  // s'ouvre sur le mail et le contact — et le prestataire absent de l'annuaire s'y CRÉE, sans
  // perdre le formulaire à moitié rempli.
  | {
      type: "parties"; name: string; label: string;
      /**
       * Les contacts, passés par la page serveur qui rend le formulaire. OMIS, le sélecteur les
       * cherche lui-même (`/api/annuaire/parties`) — c'est le cas des formulaires qui vivent loin
       * de toute page serveur, comme « Pièces liées » sur une fiche (§118.148). Rendre ce champ
       * obligatoire poussait ces formulaires à garder une partie en TEXTE LIBRE, que les actions
       * ne lisent plus : l'engagement créé depuis une fiche était refusé, faute de partie.
       */
      options?: PartyOption[];
      defaultValue?: string[];
      /** `1` pour un expéditeur ou un destinataire ; « many » pour les parties d'un contrat. */
      arity?: PartyArity;
      /** Le droit d'écriture de l'annuaire, calculé au serveur — jamais deviné ici. */
      canCreate?: boolean;
      required?: boolean;
      placeholder?: string;
      hint?: string; full?: boolean;
      /** Ce que la lecture d'une pièce propose — un contact à confirmer, ou à créer avec ce qui a été lu. */
      propose?: PartiesProposees;
    };

/**
 * Les champs QUI S'AFFICHENT — tous sauf le champ caché.
 *
 * Certains écrans dessinent eux-mêmes leur formulaire à partir d'une liste de `FieldDef` (les
 * champs propres à un type de demande administrative, par exemple) et lisent `label` sur chacun.
 * Un champ caché n'a pas de libellé : les typer avec celui-ci évite de leur faire traiter un cas
 * qui ne se présentera jamais chez eux.
 */
export type VisibleFieldDef = Exclude<FieldDef, { type: "hidden" }>;

interface CreateRecordButtonProps {
  label: string;
  title: string;
  description?: string;
  fields: FieldDef[];
  action: (prev: ActionResult | undefined, formData: FormData) => Promise<ActionResult>;
  /** Optional base path; on success navigates to `${redirectBase}/${id}`. */
  redirectBase?: string;
  width?: "md" | "lg";
  /** Optional AI prefill: analyse a file, prefill the fields (editable). */
  analyze?: AnalyzePrefill;
  /** Nom du paramètre d'URL qui ouvre le formulaire à l'arrivée (ex. « new »). */
  autoOpenParam?: string;
}

interface RecordFormProps {
  fields: FieldDef[];
  action: (prev: ActionResult | undefined, formData: FormData) => Promise<ActionResult>;
  /** Optional base path; on success navigates to `${redirectBase}/${id}`. */
  redirectBase?: string;
  /** Optional AI prefill: analyse a file, prefill the fields (editable). */
  analyze?: AnalyzePrefill;
  /** Création réussie — l'appelant referme le panneau qui porte ce formulaire. */
  onDone: () => void;
  /** Bouton secondaire : fermer ici, revenir au choix de la nature depuis Ad & Pro. */
  onCancel: () => void;
  cancelLabel?: string;
  submitLabel?: string;
  /** Les champs remplis depuis une pièce, et leur preuve (`MarqueDeChamp`). */
  marques?: Partial<Record<string, MarqueDeChamp>>;
  /** Les fichiers déjà choisis (la pièce lue), posés dans leur champ fichier : on ne téléverse pas deux fois. */
  fichiersInitiaux?: Partial<Record<string, File[]>>;
  /** Le fichier du Drive déjà désigné (la pièce lue), posé dans son champ. */
  drivesInitiaux?: Partial<Record<string, DrivePickerValue>>;
  /** Ce qui s'affiche au-dessus des champs (la phrase de la lecture). */
  entete?: React.ReactNode;
  formRef?: React.Ref<HTMLFormElement>;
  /** Un champ vient d'être touché par la personne. */
  onTouched?: (name: string) => void;
}

/** Poser des fichiers dans un `<input type="file">` — le navigateur l'admet par un `DataTransfer`. */
function poserFichiers(input: HTMLInputElement, fichiers: readonly File[]): void {
  try {
    const dt = new DataTransfer();
    for (const f of fichiers) dt.items.add(f);
    input.files = dt.files;
  } catch {
    // Un navigateur qui le refuse : le champ reste vide, la personne rejoint le fichier elle-même.
  }
}

const LIBELLE_MARQUE: Record<MarqueDeChamp["source"], string> = {
  REGLES: "lu dans le document", LUNA: "lu par Luna", CALCUL: "calculée",
};

/** La pastille d'un champ rempli depuis la pièce : survolée, elle dit sa preuve ; cliquée, elle l'affiche. */
function PastilleMarque({ marque, ouverte, onToggle }: { marque: MarqueDeChamp; ouverte: boolean; onToggle: () => void }) {
  const titre = `${marque.preuve}${marque.ou ? ` (${marque.ou})` : ""}`;
  return (
    <button
      type="button" onClick={onToggle} title={titre} aria-expanded={ouverte}
      aria-label={`${LIBELLE_MARQUE[marque.source]} — voir d'où vient cette valeur`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium leading-[18px]",
        marque.source === "CALCUL" ? "border-primary/20 bg-primary/5 text-primary" : "border-luna/30 text-luna",
      )}
    >
      <Sparkles className="h-3 w-3" /> {LIBELLE_MARQUE[marque.source]}
    </button>
  );
}

/**
 * LE FORMULAIRE SEUL, sans son bouton ni son panneau.
 *
 * Il existe séparément parce qu'il a désormais deux points de montage : l'écran du module (via
 * `CreateRecordButton`, qui lui ajoute bouton + panneau) et le panneau commun d'Ad & Pro, où l'on
 * a déjà choisi la nature de sa demande — et où ouvrir un second panneau par-dessus le premier
 * n'aurait aucun sens.
 */
/**
 * CHOISIR PLUSIEURS ENTRÉES DANS UNE LISTE QUI PEUT ÊTRE LONGUE.
 *
 * ── POURQUOI UNE BARRE DE RECHERCHE ─────────────────────────────────────────────────────────
 *
 * Le champ affichait toutes les options dans une boîte à défilement. Cela tient pour douze
 * collaborateurs ; l'annuaire des médecins en compte des centaines, et le référentiel des wilayas
 * cinquante-huit. Faire défiler pour trouver « Dr Zerrouki » n'est pas un inconfort : c'est ce qui
 * fait renoncer, et écrire le nom dans la description où plus rien ne le compte.
 *
 * ── CE QUI RESTE VISIBLE MÊME QUAND ON FILTRE ───────────────────────────────────────────────
 *
 * Les entrées DÉJÀ COCHÉES restent dans la liste quoi qu'on tape. Sans cela, chercher un second
 * nom ferait disparaître le premier de l'écran — et l'on décoche par réflexe ce qu'on croit avoir
 * perdu. Le compteur dit combien sont retenues, y compris hors filtre.
 *
 * Les cases sont de VRAIES cases nommées : le formulaire les envoie sans JavaScript de notre
 * part, et le serveur lit `formData.getAll(name)` comme avant.
 */
/**
 * LE CHOIX MULTIPLE, EXPORTÉ — parce que deux formulaires en ont besoin et qu'un seul le portait.
 *
 * Le formulaire d'un ÉVÉNEMENT est dessiné à la main (il sert aussi à la MODIFICATION, avec les
 * mêmes champs) et la Direction y demande plusieurs médecins et plusieurs produits. Recopier ce
 * widget là-bas aurait dupliqué la seule partie délicate — le témoin de validité de groupe, que
 * HTML ne sait pas exprimer — et les deux copies auraient divergé sur la seule chose qui compte :
 * empêcher l'envoi quand rien n'est coché (§118.5).
 */
export function MultiSelectField({ field }: {
  field: Extract<FieldDef, { type: "multiselect" }>;
}) {
  const [query, setQuery] = React.useState("");
  const [picked, setPicked] = React.useState<string[]>(() => field.defaultValue ?? []);

  /**
   * « AU MOINS UNE CASE COCHÉE » N'EXISTE PAS EN HTML.
   *
   * `required` sur une case veut dire « CETTE case doit être cochée » — le poser sur des cases
   * qui partagent un nom exigerait qu'on les coche TOUTES (la sémantique de groupe est réservée
   * aux boutons radio). On passe donc par un témoin qui porte la validité du groupe : il est
   * focalisable (dimension non nulle, opacité zéro — un élément `display:none` ferait échouer
   * le rapport de validité du navigateur avec « contrôle non focalisable »), il ne porte aucune
   * valeur au formulaire, et il n'a qu'un rôle : empêcher l'envoi et DIRE quoi cocher.
   *
   * Ce n'est PAS la garde. Un champ de formulaire se forge : l'obligation est tenue par l'action
   * serveur, qui refuse une demande sans médecin ni produit et nomme ce qui manque. Ce témoin
   * évite l'aller-retour, il ne le remplace pas.
   */
  const temoin = React.useRef<HTMLInputElement>(null);
  // « NON PRÉSENT » : la saisie libre compte comme un choix — le témoin ne réclame une case que
  // si la saisie est vide aussi.
  const [horsOuvert, setHorsOuvert] = React.useState(() => Boolean(field.horsListe?.defaultValue?.trim()));
  const [horsTexte, setHorsTexte] = React.useState(field.horsListe?.defaultValue ?? "");
  const horsRempli = Boolean(field.horsListe) && horsOuvert && horsTexte.trim().length > 0;
  React.useEffect(() => {
    temoin.current?.setCustomValidity(
      field.required && picked.length === 0 && !horsRempli
        ? `Sélectionnez au moins une entrée pour « ${field.label} »${field.horsListe ? ` (ou cochez « ${field.horsListe.label} »)` : ""}.`
        : "",
    );
  }, [field.required, field.label, field.horsListe, picked.length, horsRempli]);

  const q = query.trim().toLowerCase();
  const visible = React.useMemo(
    () => (q ? field.options.filter((o) => o.label.toLowerCase().includes(q) || picked.includes(o.value)) : field.options),
    [field.options, q, picked],
  );
  // La recherche n'apparaît que là où elle sert : sous une dizaine d'entrées, elle prend de la
  // place et un temps de lecture pour rien.
  const searchable = field.options.length > 8;

  if (field.options.length === 0) {
    return <p className="text-xs text-muted-foreground">{field.emptyLabel ?? "Aucune option disponible."}</p>;
  }

  return (
    <>
      {searchable && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={field.searchPlaceholder ?? "Rechercher…"}
            aria-label={`Rechercher dans ${field.label}`}
            className="h-9 min-w-0 flex-1 sm:h-8"
          />
          <span className="text-xs text-muted-foreground">
            {picked.length > 0 ? `${picked.length} sélectionné(s)` : `${field.options.length} au choix`}
          </span>
        </div>
      )}
      <div className="relative mt-1 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-input p-2">
        {field.required && (
          <input
            ref={temoin} type="text" readOnly tabIndex={-1} aria-hidden
            className="pointer-events-none absolute left-0 top-0 h-px w-px opacity-0"
          />
        )}
        {visible.length === 0 ? (
          <p className="px-1.5 py-1 text-xs text-muted-foreground">Aucun résultat pour « {query} ».</p>
        ) : visible.map((o) => (
          <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-2 text-sm hover:bg-secondary sm:py-1">
            <input
              type="checkbox" name={field.name} value={o.value}
              checked={picked.includes(o.value)}
              onChange={(e) => setPicked((prev) => (e.target.checked ? [...prev, o.value] : prev.filter((v) => v !== o.value)))}
              className="h-4 w-4 rounded border-input"
            />
            {o.label}
          </label>
        ))}
      </div>
      {field.horsListe && (
        <div className="mt-1.5 space-y-1">
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={horsOuvert} onChange={(e) => setHorsOuvert(e.target.checked)} className="h-4 w-4 rounded border-input" />
            {field.horsListe.label}
          </label>
          {horsOuvert && (
            <textarea
              name={field.horsListe.name} value={horsTexte} onChange={(e) => setHorsTexte(e.target.value)} rows={2}
              placeholder={field.horsListe.placeholder ?? "Un nom par ligne"}
              aria-label={field.horsListe.label}
              className="w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary/60"
            />
          )}
        </div>
      )}
      {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
    </>
  );
}

export function RecordForm({
  fields,
  action,
  redirectBase,
  analyze,
  onDone,
  onCancel,
  cancelLabel = "Annuler",
  submitLabel = "Enregistrer",
  marques,
  fichiersInitiaux,
  drivesInitiaux,
  entete,
  formRef,
  onTouched,
}: RecordFormProps) {
  const router = useRouter();
  // LES CHAMPS TOUCHÉS : un champ rempli depuis la pièce perd son violet dès que la personne y met la main.
  const [touches, setTouches] = React.useState<ReadonlySet<string>>(() => new Set());
  const [preuveOuverte, setPreuveOuverte] = React.useState<string | null>(null);
  const toucher = React.useCallback((name: string) => {
    setTouches((prev) => (prev.has(name) ? prev : new Set(prev).add(name)));
    onTouched?.(name);
  }, [onTouched]);
  const champsFichier = React.useRef<Record<string, HTMLInputElement | null>>({});
  React.useEffect(() => {
    for (const [name, fichiers] of Object.entries(fichiersInitiaux ?? {})) {
      const input = champsFichier.current[name];
      if (input && fichiers?.length) poserFichiers(input, fichiers);
    }
  }, [fichiersInitiaux]);
  // L'appelant passe le plus souvent une lambda : on garde la dernière version dans une référence
  // pour que l'effet de succès ne se redéclenche pas au gré des rendus du parent.
  const done = React.useRef(onDone);
  done.current = onDone;
  const [submitting, setSubmitting] = React.useState(false);
  // Verrou SYNCHRONE anti double-création : un double-clic (ou double Entrée) déclenche un 2ᵉ
  // envoi AVANT que `submitting` n'ait désactivé le bouton — le verrou bloque ce 2ᵉ envoi.
  const lock = React.useRef(false);

  /**
   * LE BOUTON NE PEUT PLUS TOURNER INDÉFINIMENT.
   *
   * ── LE DÉFAUT QU'ON CORRIGE ───────────────────────────────────────────────────────────────
   *
   * `useFormState` ne met l'état à jour QUE si l'action RETOURNE. Si elle LÈVE — erreur Prisma,
   * stockage injoignable, déploiement en cours, connexion coupée — aucun état n'arrive : l'effet
   * de succès comme celui d'erreur restent muets, `submitting` reste vrai, et le bouton tourne
   * pour toujours SANS AUCUN MESSAGE. C'est exactement le symptôme rapporté (« ça tourne tourne
   * tourne »), et la raison pour laquelle on croyait que rien ne s'enregistrait.
   *
   * Le piège est plus vicieux qu'un simple bouton bloqué : plusieurs de ces actions
   * ENREGISTRENT D'ABORD puis font le lent (pièces jointes, journal, notifications). Le courrier
   * était donc souvent bien créé — mais l'écran ne le disait jamais, la personne recommençait, et
   * l'on obtenait des doublons. D'où l'interdiction, dans le message, de « réessayer » à
   * l'aveugle : on demande de VÉRIFIER LA LISTE d'abord.
   *
   * Deux garde-fous, et le second est indispensable : attraper la levée ne suffit pas si le
   * serveur ne répond JAMAIS (requête suspendue). Le chronomètre tranche ce cas-là.
   */
  const actionRef = React.useRef(action);
  actionRef.current = action;
  const guarded = React.useCallback(
    async (prev: ActionResult | undefined, fd: FormData): Promise<ActionResult> => {
      try {
        return await actionRef.current(prev, fd);
      } catch (err) {
        console.error("[form] l'action serveur a levé", err);
        return {
          ok: false,
          error: "L'enregistrement n'a pas abouti (connexion ou serveur). VÉRIFIEZ D'ABORD LA LISTE : l'enregistrement a pu se faire malgré tout — recommencer à l'aveugle créerait un doublon.",
        };
      }
    },
    [],
  );
  const [state, formAction] = useFormState<ActionResult | undefined, FormData>(guarded, undefined);

  // Pré-remplissage IA : valeurs extraites + compteur pour re-monter (reset) les champs.
  const [prefill, setPrefill] = React.useState<Record<string, string>>({});
  const [prefillVersion, setPrefillVersion] = React.useState(0);
  const [analyzing, setAnalyzing] = React.useState(false);
  const [analyzeMsg, setAnalyzeMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  async function runAnalyze() {
    if (!analyze) return;
    const f = fileRef.current?.files?.[0];
    if (!f) { setAnalyzeMsg({ ok: false, text: "Choisissez d'abord un fichier." }); return; }
    setAnalyzing(true); setAnalyzeMsg(null);
    const fd = new FormData(); fd.set("file", f);
    const r = await analyze.action(fd);
    setAnalyzing(false);
    if (!r.ok) { setAnalyzeMsg({ ok: false, text: r.error ?? "Analyse impossible." }); return; }
    setPrefill(r.values ?? {});
    setPrefillVersion((v) => v + 1);
    setAnalyzeMsg({ ok: true, text: `${Object.keys(r.values ?? {}).length} champ(s) préremplis — vérifiez et complétez.` });
  }

  /**
   * Valeur par défaut d'un champ : priorité au pré-remplissage IA.
   *
   * Le multi-sélecteur porte sa propre valeur par défaut (un TABLEAU, géré dans son composant) :
   * la rendre ici la ferait passer pour la valeur d'un `<input>` simple, et React afficherait
   * « a,b,c » dans une case de texte.
   */
  const dv = (field: FieldDef): string | number | undefined => {
    const p = prefill[field.name];
    if (p !== undefined) return p;
    if (field.type === "multiselect" || field.type === "parties") return undefined;
    return "defaultValue" in field ? field.defaultValue : undefined;
  };

  /**
   * LE CHRONOMÈTRE — pour la requête qui ne revient jamais.
   *
   * Une action qui LÈVE est attrapée juste au-dessus. Une action qui SE SUSPEND (stockage
   * injoignable, conteneur redémarré au milieu) ne lève ni ne retourne : rien ne la réveillera.
   * Au bout de 45 secondes on rend la main à la personne, en lui disant quoi faire — et
   * SURTOUT ce qu'il ne faut pas faire, c'est-à-dire recommencer sans regarder.
   */
  const [timedOut, setTimedOut] = React.useState(false);
  React.useEffect(() => {
    if (!submitting) return;
    const t = setTimeout(() => {
      setSubmitting(false);
      lock.current = false;
      setTimedOut(true);
    }, 45_000);
    return () => clearTimeout(t);
  }, [submitting]);

  React.useEffect(() => {
    if (state?.ok || state?.error) setTimedOut(false);
    if (state?.ok) {
      setSubmitting(false);
      done.current();
      // ON NE RAFRAÎCHIT PAS L'ÉCRAN QU'ON QUITTE. Quand la création ouvre la fiche du nouvel
      // objet, un `refresh()` suivi d'un `push()` faisait rendre DEUX pages au serveur — la
      // liste qu'on abandonne, puis la fiche — et le bouton tournait pendant les deux.
      // L'action a déjà invalidé le cache de la liste : elle sera à jour au retour.
      if (redirectBase && state.id) router.push(`${redirectBase}/${state.id}`);
      else router.refresh();
    } else if (state?.error) {
      setSubmitting(false);
      lock.current = false; // échec → nouvelle tentative autorisée
    }
  }, [state, router, redirectBase]);

  return (
    <>
      {analyze && (
        <div className="mb-4 space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium text-primary"><Wand2 className="h-4 w-4" /> {analyze.title}</p>
          <p className="text-xs text-muted-foreground">{analyze.hint}</p>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept={analyze.accept} disabled={analyze.disabled || analyzing}
              className="text-xs file:mr-2 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-xs file:font-medium" />
            <Button type="button" size="sm" onClick={runAnalyze} disabled={analyze.disabled || analyzing}
              title={analyze.disabled ? analyze.disabledHint : undefined}>
              {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {analyze.buttonLabel}
            </Button>
          </div>
          {analyze.disabled && analyze.disabledHint && <p className="text-xs text-amber-700">{analyze.disabledHint}</p>}
          {analyzeMsg && <p className={cn("text-xs", analyzeMsg.ok ? "text-success" : "text-destructive")}>{analyzeMsg.text}</p>}
        </div>
      )}
      {entete}
      <form
        ref={formRef}
        action={(fd) => {
          if (lock.current) return;
          lock.current = true;
          setTimedOut(false);
          setSubmitting(true);
          formAction(fd);
        }}
        className="space-y-4"
      >
        <div key={prefillVersion} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {fields.map((field) => {
            if (field.type === "hidden") return <input key={field.name} type="hidden" name={field.name} value={field.value} />;
            const marque = marques?.[field.name];
            const violet = Boolean(marque) && !touches.has(field.name);
            return (
            <div
              key={field.name}
              onChange={marque || onTouched ? () => toucher(field.name) : undefined}
              className={cn(
                "space-y-1.5", (field.full || field.type === "textarea") && "sm:col-span-2",
                marque && "rounded-lg p-2 ring-1 ring-transparent transition-colors",
                violet && "bg-luna-soft ring-luna/25",
              )}
            >
              {field.type !== "checkbox" && field.type !== "drivepicker" && (() => {
                const libelle = (
                  <Label htmlFor={field.name}>
                    {field.label}
                    {"required" in field && field.required && (
                      <span className="ml-0.5 text-destructive">*</span>
                    )}
                  </Label>
                );
                if (!marque) return libelle;
                return (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {libelle}
                    {touches.has(field.name)
                      ? <span className="text-[11px] text-muted-foreground">modifié par vous</span>
                      : <PastilleMarque marque={marque} ouverte={preuveOuverte === field.name} onToggle={() => setPreuveOuverte((o) => (o === field.name ? null : field.name))} />}
                  </div>
                );
              })()}
              {marque && preuveOuverte === field.name && !touches.has(field.name) && (
                <p className="rounded-md bg-background px-2 py-1.5 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{marque.source === "LUNA" ? "Proposé par Luna" : marque.source === "CALCUL" ? "Calculé" : "Lu par les règles"}{marque.ou ? ` · ${marque.ou}` : ""} — </span>
                  {marque.preuve}
                </p>
              )}
              {field.type === "drivepicker" ? (
                <DrivePickerField name={field.name} label={field.label} hint={field.hint} defaultValue={drivesInitiaux?.[field.name] ?? null} />
              ) : field.type === "file" ? (
                <>
                  <input
                    ref={(el) => { champsFichier.current[field.name] = el; }}
                    id={field.name}
                    type="file"
                    name={field.name}
                    multiple={field.multiple}
                    required={field.required}
                    accept={field.accept}
                    className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium"
                  />
                  {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
                </>
              ) : field.type === "textarea" ? (
                <Textarea id={field.name} name={field.name} required={field.required} placeholder={field.placeholder} defaultValue={dv(field) as string | undefined} />
              ) : field.type === "select" ? (
                <>
                  <Select id={field.name} name={field.name} required={field.required} defaultValue={dv(field) as string | undefined}>
                    {field.placeholder && <option value="">{field.placeholder}</option>}
                    {field.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                  {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
                </>
              ) : field.type === "checkbox" ? (
                <>
                  {field.temoin && <input type="hidden" name={field.name} value="off" />}
                  <label className="flex items-center gap-2 py-1 text-sm">
                    <input type="checkbox" name={field.name} defaultChecked={field.defaultChecked} className="h-4 w-4 rounded border-input" />
                    {field.label}
                  </label>
                  {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
                </>
              ) : field.type === "multiselect" ? (
                <MultiSelectField field={field} />
              ) : field.type === "parties" ? (
                <>
                  {/* Un sélecteur de boutons n'émet pas de « change » : c'est le clic qui dit qu'on y a mis la main. */}
                  <div onClickCapture={marque || onTouched ? () => toucher(field.name) : undefined}>
                    <PartyPicker
                      name={field.name} options={field.options} defaultValue={field.defaultValue}
                      arity={field.arity} canCreate={field.canCreate} placeholder={field.placeholder}
                      propose={field.propose}
                    />
                  </div>
                  {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
                </>
              ) : (
                <>
                  <Input
                    id={field.name}
                    name={field.name}
                    type={field.type}
                    required={field.required}
                    placeholder={field.placeholder}
                    defaultValue={dv(field)}
                    step={field.type === "number" ? "any" : undefined}
                    inputMode={field.inputMode ?? (field.type === "number" ? "decimal" : undefined)}
                    autoComplete={field.autoComplete}
                  />
                  {"hint" in field && field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
                </>
              )}
            </div>
            );
          })}
        </div>

        {state?.error && (
          <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {state.error}
          </div>
        )}

        {timedOut && !state?.error && (
          <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-sm text-foreground">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span>
              Le serveur n&apos;a pas répondu. <strong>Fermez et regardez la liste avant de
              recommencer</strong> : l&apos;enregistrement a pu aboutir, et un second envoi
              créerait un doublon.
            </span>
          </div>
        )}

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {submitLabel}
          </Button>
        </div>
      </form>
    </>
  );
}

/**
 * Le bouton « Nouveau… » d'un écran de module : il n'est plus qu'un déclencheur et un panneau
 * autour de `RecordForm`. Le formulaire se remonte à chaque ouverture — une erreur affichée la
 * fois précédente ne revient donc pas accueillir la suivante.
 */
export function CreateRecordButton({
  label,
  title,
  description,
  fields,
  action,
  redirectBase,
  width = "lg",
  analyze,
  autoOpenParam,
}: CreateRecordButtonProps) {
  const [open, setOpen] = React.useState(false);

  // Ouverture depuis un lien direct (`?new=1`) — voir `useAutoOpen`.
  useAutoOpen(autoOpenParam, () => setOpen(true));

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        {label}
      </Button>

      <Sheet open={open} onClose={() => setOpen(false)} title={title} description={description} width={width}>
        <RecordForm
          fields={fields}
          action={action}
          redirectBase={redirectBase}
          analyze={analyze}
          onDone={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </Sheet>
    </>
  );
}
