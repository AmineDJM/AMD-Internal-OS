"use client";

import * as React from "react";
import { Download, Loader2, Pencil, Save, X } from "lucide-react";
import { DocxView, XlsxView, PptxView } from "./office-viewers";
import { EditeurEnLigne, type SessionPrete } from "./editeur-en-ligne";
import { BoutonTelecharger } from "@/components/telechargement/bouton-telecharger";
import { natureApercu, visionneuseDeSecours, TAILLE_MAX_TEXTE_OCTETS, type NatureApercu } from "@/lib/formats/apercu";

/**
 * L'APERÇU UNIVERSEL — un seul composant, pour le Drive, les documents et les pièces (Direction, 06/10 : « quand on
 * ouvre un Word, on voit un Word, on peut le modifier, et tout se passe sur le serveur — pareil pour tout ce qui est
 * modifiable : le lire dans son format exact, le modifier, le supprimer »).
 *
 *   • Word, Excel, PowerPoint ET leurs anciens formats (.doc, .xls, .ppt, .rtf, .odt, .ods, .odp, .pages, .key…) :
 *     ouverts dans l'ÉDITEUR OFFICE, dans leur forme exacte — modifiables sur place si l'on a le droit, en lecture
 *     sinon. Le Document Server lit le fichier d'origine et enregistre sur le serveur ; le PC n'affiche que l'interface
 *     (plus de décodage dans l'onglet). Si l'éditeur n'est pas disponible, la visionneuse du navigateur prend le
 *     relais (Word, Excel, PowerPoint modernes), sinon le téléchargement : jamais une page blanche ;
 *   • le texte (code, journaux, JSON, YAML, Markdown, SQL…) : lu ET modifiable ici — la lecture, la vérification et
 *     l'enregistrement (nouvelle version, conflit détecté) se font sur le serveur ;
 *   • les formats que le navigateur lit seul (image, vidéo, son, PDF) : tels quels ;
 *   • le HTML : dans un cadre ISOLÉ (`sandbox=""`), jamais exécuté dans l'application ;
 *   • tout le reste : la raison est dite et le téléchargement reste à un clic.
 *
 * SUPPRIMER et RENOMMER restent dans la barre d'outils de la fenêtre (selon les droits). Le fichier d'origine n'est
 * jamais converti en autre chose pour l'afficher.
 */
export function ApercuUniversel({
  src, name, mime, telechargement, cible, session, plein,
}: {
  /** La route qui sert les octets du fichier. */
  src: string;
  name: string;
  mime?: string | null;
  /** L'adresse de téléchargement de l'original. */
  telechargement: string;
  /** Le fichier dans l'éditeur / l'éditeur de texte : Drive ou document. Absent (autre source) : visionneuses du navigateur. */
  cible?: { type: "drive" | "document"; id: string };
  /** Configuration de l'éditeur déjà préparée par la page (fichier ouvert du Drive) : aucun aller-retour en plus. */
  session?: SessionPrete;
  /** Occuper toute la hauteur disponible (fichier ouvert du Drive), au lieu d'un aperçu dans une fenêtre. */
  plein?: boolean;
}) {
  const nature = natureApercu(name, mime);
  return <Rendu nature={nature} src={src} name={name} telechargement={telechargement} cible={cible} session={session} plein={plein} />;
}

function Rendu({ nature, src, name, telechargement, cible, session, plein }: {
  nature: NatureApercu; src: string; name: string; telechargement: string; cible?: { type: "drive" | "document"; id: string };
  session?: SessionPrete; plein?: boolean;
}) {
  if (plein && nature === "pdf") return <iframe src={src} title={name} className="h-full w-full border-0 bg-white" />;
  switch (nature) {
    case "image":
      // `dvh` et non `vh` : au téléphone, la barre d'adresse mobile ne mange plus le bas de l'aperçu.
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={src} alt={name} className="mx-auto max-h-[78dvh] max-w-full rounded-lg object-contain" />;
    case "video":
      return <video src={src} controls className="mx-auto max-h-[78dvh] w-full rounded-lg bg-black" />;
    case "audio":
      return <audio src={src} controls className="w-full" />;
    case "pdf":
      return <iframe src={src} title={name} className="h-[78dvh] w-full rounded-lg border border-border bg-white" />;
    case "docx":
    case "xlsx":
    case "pptx":
    case "converti": {
      // La visionneuse se choisit sur l'EXTENSION, pas sur la nature : un .dotx ou un .xltx (« converti ») a la sienne.
      const famille = visionneuseDeSecours(name);
      const viseuse = famille === "docx" ? <DocxView src={src} name={name} /> : famille === "xlsx" ? <XlsxView src={src} name={name} /> : famille === "pptx" ? <PptxView src={src} name={name} /> : null;
      const secours = (message: string) => (
        <div className="space-y-3">
          <p className="rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
            {message} {viseuse ? "Affichage de secours dans le navigateur (lecture seule)." : ""}
          </p>
          {viseuse ?? <SansApercu nom={name} telechargement={telechargement} raison="Ce format s'ouvre dans l'éditeur Office, qui n'est pas joignable pour le moment : téléchargez le fichier pour l'ouvrir." />}
        </div>
      );
      return cible
        ? <EditeurEnLigne type={cible.type} id={cible.id} name={name} secours={secours} session={session} plein={plein} />
        : (viseuse ?? <SansApercu nom={name} telechargement={telechargement} raison="Ce format s'ouvre dans l'éditeur Office depuis le Drive ou la fiche du document : téléchargez le fichier pour l'ouvrir." />);
    }
    case "texte":
      return cible
        ? <EditeurTexte cible={cible} name={name} telechargement={telechargement} />
        : <VueTexte src={src} name={name} telechargement={telechargement} />;
    case "html":
      return <VueHtml src={src} name={name} telechargement={telechargement} />;
    default:
      return <SansApercu nom={name} telechargement={telechargement} raison="Ce type de fichier n'a pas d'aperçu (binaire, exécutable, format propriétaire)." />;
  }
}

async function messageDErreur(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { error?: string };
    if (j?.error) return j.error;
  } catch { /* corps non JSON */ }
  return `Lecture impossible (HTTP ${r.status}).`;
}

/** Charge un fichier en texte ; l'erreur du serveur est rapportée telle quelle. */
function useTexte(url: string) {
  const [etat, setEtat] = React.useState<{ chargement: boolean; texte: string; tronque: boolean; erreur: string | null }>({ chargement: true, texte: "", tronque: false, erreur: null });
  React.useEffect(() => {
    let vivant = true;
    setEtat({ chargement: true, texte: "", tronque: false, erreur: null });
    fetch(url, { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(await messageDErreur(r));
        const tampon = await r.arrayBuffer();
        const tronque = tampon.byteLength > TAILLE_MAX_TEXTE_OCTETS;
        const texte = new TextDecoder("utf-8", { fatal: false }).decode(tronque ? tampon.slice(0, TAILLE_MAX_TEXTE_OCTETS) : tampon);
        if (vivant) setEtat({ chargement: false, texte, tronque, erreur: null });
      })
      .catch((e: unknown) => { if (vivant) setEtat({ chargement: false, texte: "", tronque: false, erreur: e instanceof Error ? e.message : "Lecture impossible." }); });
    return () => { vivant = false; };
  }, [url]);
  return etat;
}

function Attente({ texte = "Préparation de l'aperçu…" }: { texte?: string }) {
  return (
    <div className="flex min-h-[30vh] items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> {texte}
    </div>
  );
}

function VueTexte({ src, name, telechargement }: { src: string; name: string; telechargement: string }) {
  const { chargement, texte, tronque, erreur } = useTexte(src);
  if (chargement) return <Attente />;
  if (erreur) return <SansApercu nom={name} telechargement={telechargement} raison={erreur} />;
  return (
    <div className="space-y-2">
      <pre className="max-h-[78dvh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 font-mono text-xs leading-relaxed">{texte}</pre>
      {tronque && <p className="text-xs text-muted-foreground">Aperçu limité au premier mégaoctet : téléchargez le fichier pour le lire en entier.</p>}
    </div>
  );
}

/**
 * LE TEXTE, LU ET MODIFIÉ SUR LE SERVEUR. Le navigateur n'affiche qu'une zone de texte : la lecture, la vérification de
 * version et l'enregistrement sont des appels au serveur (`/api/{documents|drive}/<id>/texte`). Si quelqu'un a enregistré
 * entre-temps, l'enregistrement est refusé avec la raison (rien n'est écrasé en silence).
 */
function EditeurTexte({ cible, name, telechargement }: { cible: { type: "drive" | "document"; id: string }; name: string; telechargement: string }) {
  const url = `/api/${cible.type === "drive" ? "drive" : "documents"}/${encodeURIComponent(cible.id)}/texte`;
  const [charge, setCharge] = React.useState<{ texte: string; tronque: boolean; modifiable: boolean; version: number } | null>(null);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [edition, setEdition] = React.useState(false);
  const [brouillon, setBrouillon] = React.useState("");
  const [enregistrement, setEnregistrement] = React.useState(false);
  const [message, setMessage] = React.useState<{ ok: boolean; texte: string } | null>(null);

  const lire = React.useCallback(async () => {
    setErreur(null);
    try {
      const r = await fetch(url, { credentials: "same-origin", cache: "no-store" });
      if (!r.ok) throw new Error(await messageDErreur(r));
      const j = (await r.json()) as { texte: string; tronque: boolean; modifiable: boolean; version: number };
      setCharge(j);
      setBrouillon(j.texte);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "Lecture impossible.");
    }
  }, [url]);
  React.useEffect(() => { void lire(); }, [lire]);

  if (erreur) return <SansApercu nom={name} telechargement={telechargement} raison={erreur} />;
  if (!charge) return <Attente />;

  const enregistrer = async () => {
    setEnregistrement(true); setMessage(null);
    try {
      const r = await fetch(`${url}/enregistrer`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texte: brouillon, version: charge.version }) });
      if (!r.ok) throw new Error(await messageDErreur(r));
      const j = (await r.json()) as { version: number };
      setCharge({ ...charge, texte: brouillon, version: j.version });
      setEdition(false);
      setMessage({ ok: true, texte: "Enregistré (nouvelle version)." });
    } catch (e) {
      setMessage({ ok: false, texte: e instanceof Error ? e.message : "Enregistrement impossible." });
    } finally {
      setEnregistrement(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {charge.modifiable && !edition && (
          <button type="button" onClick={() => { setBrouillon(charge.texte); setMessage(null); setEdition(true); }} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-2 text-xs font-medium sm:py-1.5 hover:bg-secondary">
            <Pencil className="h-3.5 w-3.5" /> Modifier
          </button>
        )}
        {edition && (
          <>
            <button type="button" onClick={enregistrer} disabled={enregistrement || brouillon === charge.texte} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-2 text-xs font-medium sm:py-1.5 text-primary-foreground hover:opacity-90 disabled:opacity-50">
              {enregistrement ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Enregistrer
            </button>
            <button type="button" onClick={() => { setEdition(false); setBrouillon(charge.texte); setMessage(null); }} disabled={enregistrement} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-2 text-xs font-medium sm:py-1.5 hover:bg-secondary">
              <X className="h-3.5 w-3.5" /> Annuler
            </button>
          </>
        )}
        {message && <span className={message.ok ? "text-xs text-success" : "text-xs text-destructive"} role="status">{message.texte}</span>}
        {message && !message.ok && edition && (
          <button type="button" onClick={() => void lire().then(() => setEdition(false))} className="text-xs text-primary hover:underline">Rouvrir la dernière version</button>
        )}
      </div>
      {edition ? (
        <textarea
          value={brouillon} onChange={(e) => setBrouillon(e.target.value)} spellCheck={false} aria-label={`Contenu de ${name}`}
          className="h-[70dvh] w-full resize-y rounded-lg border border-input bg-background p-3 font-mono text-base leading-relaxed focus-ring sm:text-xs"
        />
      ) : (
        <pre className="max-h-[78dvh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 font-mono text-xs leading-relaxed">{charge.texte}</pre>
      )}
      {charge.tronque && <p className="text-xs text-muted-foreground">Fichier de plus d&apos;1 Mo : aperçu limité au début, et non modifiable d&apos;ici (enregistrer écraserait la fin). Téléchargez-le pour le modifier.</p>}
    </div>
  );
}

function VueHtml({ src, name, telechargement }: { src: string; name: string; telechargement: string }) {
  const { chargement, texte, tronque, erreur } = useTexte(src);
  if (chargement) return <Attente />;
  if (erreur) return <SansApercu nom={name} telechargement={telechargement} raison={erreur} />;
  return (
    <div className="space-y-2">
      {/* sandbox="" : aucun script, aucun formulaire, aucune navigation — le HTML d'un tiers ne s'exécute pas ici. */}
      <iframe sandbox="" srcDoc={texte} title={name} className="h-[78dvh] w-full rounded-lg border border-border bg-white" />
      {tronque && <p className="text-xs text-muted-foreground">Aperçu limité au premier mégaoctet : téléchargez le fichier pour le lire en entier.</p>}
    </div>
  );
}

/** JAMAIS UNE PAGE BLANCHE : la raison est dite, et le téléchargement de l'original reste à un clic. */
export function SansApercu({ nom, telechargement, raison }: { nom: string; telechargement: string; raison: string }) {
  return (
    <div className="flex min-h-[30vh] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-muted/30 p-4 text-center sm:p-8">
      <p className="max-w-xl text-sm text-muted-foreground">{raison}</p>
      <BoutonTelecharger href={telechargement} nom={nom} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
        <Download className="h-4 w-4" /> Télécharger le fichier
      </BoutonTelecharger>
    </div>
  );
}
