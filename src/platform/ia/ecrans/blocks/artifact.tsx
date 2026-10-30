"use client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ARTIFACT WORKSPACE (§5-6, §28, §31-34) — le document, VIVANT, dans le fil de conversation.
 *
 * ── LE SERVEUR ENVOIE UN MODÈLE, LE NAVIGATEUR FAIT LA MISE EN PAGE ─────────────────────
 *
 * Pas d'images de pages pour le Word, l'Excel et le PowerPoint : le navigateur MESURE le texte
 * pour de vrai. Une police de 16 pt en Aptos y occupe exactement la largeur qu'elle occupera
 * dans Word, ce qu'aucune estimation côté serveur ne peut promettre. Et surtout : le texte
 * reste SÉLECTIONNABLE, donc cliquable — c'est ce qui permet de désigner un paragraphe du doigt
 * plutôt que de le décrire (§31).
 *
 * Le PDF fait exception, parce qu'un PDF n'a pas de modèle à re-dessiner : il EST une mise en
 * page. Ses pages sont donc rastérisées par MuPDF, à la demande, page par page.
 *
 * ── UNE SEULE CARTE QUI SE TRANSFORME (§64) ─────────────────────────────────────────────
 *
 * Le composant tient la vue en état local et la REMPLACE à chaque geste. Trois retouches ne
 * font pas trois cartes empilées : la même se transforme, comme le document sous les yeux de
 * quelqu'un devant Word.
 *
 * ── RESPONSIVE ──────────────────────────────────────────────────────────────────────────
 *
 * Le même composant sur téléphone : la barre d'outils passe sur deux lignes, les miniatures
 * défilent horizontalement, la page se met à l'échelle de la largeur disponible. Les tailles
 * viennent de `artifact.css`, en unités relatives.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import * as React from "react";
import {
  ChevronLeft, ChevronRight, Loader2, Redo2, Save, Undo2, X, ZoomIn, ZoomOut,
} from "lucide-react";
import type {
  BlocVue, VueArtefact, VueDocx, VuePdf, VuePptx, VueXlsx,
} from "@/platform/ia/artifact/view-types";
import type { WorkspaceBlock } from "@/platform/ia/workspace/protocol";
import {
  annulerArtefact, fermerArtefact, phraseArtefact, retablirArtefact, sauvegarderArtefact,
  viserArtefact,
} from "@/platform/ia/artifact/actions";
import { AskContext } from "../primitives";
import { useConfirmer } from "@/components/ui/dialogue";
import "./artifact.css";

const CM_PAR_POUCE = 2.54;
/** Un centimètre à l'écran, à 96 points par pouce — l'unité de référence du rendu Word. */
const PX_PAR_CM = 96 / CM_PAR_POUCE;

type BlocArtefact = Extract<WorkspaceBlock, { kind: "artifact" }>;

export function ArtifactBlock({ b }: { b: BlocArtefact }) {
  const confirmer = useConfirmer();
  const [vue, setVue] = React.useState<VueArtefact>(b.vue);
  const [occupe, setOccupe] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [zoom, setZoom] = React.useState(1);
  const [ferme, setFerme] = React.useState(false);
  const ask = React.useContext(AskContext);

  /**
   * Le serveur peut renvoyer une vue plus récente que celle du composant (une phrase traitée
   * dans la conversation, une reprise après rechargement). On ne remplace QUE vers l'avant :
   * une révision qui recule serait une réponse en retard qui écrase une modification plus
   * récente — le défaut classique des interfaces optimistes.
   */
  React.useEffect(() => {
    setVue((actuelle) => (b.vue.revision >= actuelle.revision ? b.vue : actuelle));
  }, [b.vue]);

  const appliquer = React.useCallback(async (travail: () => Promise<{ ok: boolean; message: string; vue: VueArtefact | null }>) => {
    setOccupe(true);
    setMessage(null);
    try {
      const r = await travail();
      if (r.vue) setVue((a) => (r.vue!.revision >= a.revision ? r.vue! : a));
      if (r.message) setMessage(r.message);
      return r;
    } catch (e) {
      setMessage(`Erreur : ${(e as Error).message}`);
      return { ok: false, message: "", vue: null };
    } finally {
      setOccupe(false);
    }
  }, []);



  const enregistrer = () => appliquer(() => sauvegarderArtefact(vue.sessionId));
  const annuler = () => appliquer(() => annulerArtefact(vue.sessionId));
  const retablir = () => appliquer(() => retablirArtefact(vue.sessionId));

  const fermer = async () => {
    if (vue.dirty && !(await confirmer("Des modifications ne sont pas enregistrées. Fermer quand même ?"))) return;
    await fermerArtefact(vue.sessionId);
    setFerme(true);
  };

  /**
   * LA BARRE DE COMMANDE. Le décodeur direct répond en quelques millisecondes ; s'il ne
   * reconnaît rien, la phrase part dans la conversation d'Adam, où le modèle prend le relais.
   * La personne n'a pas à savoir laquelle des deux voies a servi.
   */
  const envoyerPhrase = async (phrase: string) => {
    const r = await appliquer(() => phraseArtefact(vue.sessionId, phrase));
    if ("aDeleguer" in r && r.aDeleguer && ask) {
      setMessage("Je regarde…");
      ask(phrase);
    }
  };

  // Le registre de rendu exige un élément : on rend une trace discrète plutôt que `null`, ce qui
  // dit aussi à la personne que le document a bien été fermé au lieu de disparaître sans mot.
  if (ferme) {
    return <p className="artifact-ferme">Document fermé — dites-moi de le rouvrir si besoin.</p>;
  }

  return (
    <div className="artifact" data-format={vue.format} data-etat={vue.etat}>
      <BarreOutils
        vue={vue} occupe={occupe} zoom={zoom}
        onZoom={setZoom} onAnnuler={annuler} onRetablir={retablir}
        onEnregistrer={enregistrer} onFermer={fermer}
      />

      {vue.alertes.length > 0 && (
        <ul className="artifact-alertes" aria-label="Contrôle qualité">
          {vue.alertes.map((a) => <li key={a}>{a}</li>)}
        </ul>
      )}

      <div className="artifact-scene" data-occupe={occupe ? "1" : "0"}>
        {vue.contenu.kind === "DOCX" && (
          <SceneDocx vue={vue} contenu={vue.contenu} zoom={zoom} surbrillance={vue.surbrillance}
            onCliquer={(id) => appliquer(() => viserArtefact(vue.sessionId, { selection: [id] }))} />
        )}
        {vue.contenu.kind === "PDF" && (
          <ScenePdf vue={vue} contenu={vue.contenu} zoom={zoom}
            onPage={(p) => appliquer(() => viserArtefact(vue.sessionId, { page: p }))} />
        )}
        {vue.contenu.kind === "PPTX" && (
          <ScenePptx vue={vue} contenu={vue.contenu} zoom={zoom}
            onDiapo={(d) => appliquer(() => viserArtefact(vue.sessionId, { diapo: d }))}
            onForme={(id) => appliquer(() => viserArtefact(vue.sessionId, { selection: [id] }))} />
        )}
        {vue.contenu.kind === "XLSX" && (
          <SceneXlsx vue={vue} contenu={vue.contenu}
            onFeuille={(f) => appliquer(() => viserArtefact(vue.sessionId, { feuille: f }))}
            onCellule={(id) => appliquer(() => viserArtefact(vue.sessionId, { selection: [id] }))} />
        )}
      </div>

      <BarreCommande occupe={occupe} onEnvoyer={envoyerPhrase} format={vue.format} />
      {message && <p className="artifact-message" role="status">{message}</p>}
      {vue.historique.length > 0 && <Historique vue={vue} />}
    </div>
  );
}

// ─────────────────────────── Barre d'outils ───────────────────────────

function BarreOutils(props: {
  vue: VueArtefact; occupe: boolean; zoom: number;
  onZoom: (z: number) => void; onAnnuler: () => void; onRetablir: () => void;
  onEnregistrer: () => void; onFermer: () => void;
}) {
  const { vue, occupe } = props;
  const etat = vue.dirty
    ? "Modifications non enregistrées"
    : vue.savedVersion
      ? `Enregistré — version ${vue.savedVersion}`
      : `Version ${vue.baseVersion}`;
  return (
    <header className="artifact-barre">
      <div className="artifact-identite">
        <span className="artifact-format">{vue.format}</span>
        <strong className="artifact-nom" title={vue.nom}>{vue.nom}</strong>
        <span className={`artifact-etat${vue.dirty ? " artifact-etat-sale" : ""}`}>{etat}</span>
      </div>
      <div className="artifact-outils">
        {vue.format !== "XLSX" && (
          <>
            <button type="button" className="artifact-bouton" aria-label="Réduire" disabled={props.zoom <= 0.5}
              onClick={() => props.onZoom(Math.max(0.5, Math.round((props.zoom - 0.1) * 10) / 10))}>
              <ZoomOut size={15} />
            </button>
            <span className="artifact-zoom">{Math.round(props.zoom * 100)} %</span>
            <button type="button" className="artifact-bouton" aria-label="Agrandir" disabled={props.zoom >= 2}
              onClick={() => props.onZoom(Math.min(2, Math.round((props.zoom + 0.1) * 10) / 10))}>
              <ZoomIn size={15} />
            </button>
          </>
        )}
        <button type="button" className="artifact-bouton" onClick={props.onAnnuler}
          disabled={occupe || !vue.peutAnnuler} aria-label="Annuler la dernière modification">
          <Undo2 size={15} />
        </button>
        <button type="button" className="artifact-bouton" onClick={props.onRetablir}
          disabled={occupe || !vue.peutRetablir} aria-label="Rétablir">
          <Redo2 size={15} />
        </button>
        <button type="button" className="artifact-bouton artifact-bouton-primaire" onClick={props.onEnregistrer}
          disabled={occupe || !vue.dirty} aria-label="Enregistrer">
          {occupe ? <Loader2 size={15} className="artifact-tourne" /> : <Save size={15} />}
          <span>Enregistrer</span>
        </button>
        <button type="button" className="artifact-bouton" onClick={props.onFermer} aria-label="Fermer le document">
          <X size={15} />
        </button>
      </div>
    </header>
  );
}

function BarreCommande({ occupe, onEnvoyer, format }: { occupe: boolean; onEnvoyer: (p: string) => void; format: string }) {
  const [texte, setTexte] = React.useState("");
  const exemple = {
    DOCX: "Centre le titre, réduis-le à 16…",
    PDF: "Supprime les pages 12, 14 et 18…",
    PPTX: "Diapo 2 : le titre un peu plus à gauche…",
    XLSX: "Mets B4 à 120000…",
  }[format] ?? "Dites ce qu'il faut changer…";

  return (
    <form
      className="artifact-commande"
      onSubmit={(e) => {
        e.preventDefault();
        const v = texte.trim();
        if (!v || occupe) return;
        setTexte("");
        onEnvoyer(v);
      }}
    >
      <input
        type="text" value={texte} onChange={(e) => setTexte(e.target.value)}
        placeholder={exemple} disabled={occupe} aria-label="Instruction sur le document"
        className="artifact-saisie"
      />
      <button type="submit" className="artifact-bouton artifact-bouton-primaire" disabled={occupe || !texte.trim()}>
        Appliquer
      </button>
    </form>
  );
}

function Historique({ vue }: { vue: VueArtefact }) {
  const [ouvert, setOuvert] = React.useState(false);
  const vivantes = vue.historique.filter((h) => !h.annulee).length;
  return (
    <details className="artifact-historique" open={ouvert} onToggle={(e) => setOuvert((e.target as HTMLDetailsElement).open)}>
      <summary>{vivantes} modification{vivantes > 1 ? "s" : ""} depuis l&apos;ouverture</summary>
      <ol>
        {vue.historique.map((h) => (
          <li key={h.operationId} className={h.annulee ? "artifact-annulee" : undefined}>{h.resume}</li>
        ))}
      </ol>
    </details>
  );
}

// ─────────────────────────── Word ───────────────────────────

/** Le style d'un bloc, traduit en CSS. Les points de Word sont des points CSS : rien à convertir. */
function styleDuBloc(b: BlocVue): React.CSSProperties {
  return {
    textAlign: (b.alignement ?? undefined) as React.CSSProperties["textAlign"],
    fontWeight: b.style.bold ? 700 : undefined,
    fontStyle: b.style.italic ? "italic" : undefined,
    textDecoration: b.style.underline ? "underline" : undefined,
    fontSize: b.style.sizePt ? `${b.style.sizePt}pt` : undefined,
    // La police demandée d'abord, puis un repli lisible : « Aptos » n'est pas installée partout,
    // et une police manquante ne doit pas faire retomber la page sur du Times par surprise.
    fontFamily: b.style.font ? `"${b.style.font}", "Segoe UI", system-ui, sans-serif` : undefined,
    color: b.style.color ? `#${b.style.color}` : undefined,
    marginLeft: b.indentLeftCm ? `${b.indentLeftCm}cm` : undefined,
    marginRight: b.indentRightCm ? `${b.indentRightCm}cm` : undefined,
    marginTop: b.spacingBeforePt !== null ? `${b.spacingBeforePt}pt` : undefined,
    marginBottom: b.spacingAfterPt !== null ? `${b.spacingAfterPt}pt` : undefined,
  };
}

export function SceneDocx({ vue, contenu, zoom, surbrillance, onCliquer }: {
  vue: VueArtefact; contenu: VueDocx; zoom: number; surbrillance: string[]; onCliquer: (id: string) => void;
}) {
  const enSurbrillance = new Set(surbrillance);
  return (
    <div className="artifact-papier-cadre">
      <div
        className="artifact-papier"
        style={{
          width: `${contenu.pageWidthCm * PX_PAR_CM * zoom}px`,
          minHeight: `${contenu.pageHeightCm * PX_PAR_CM * zoom}px`,
          padding: `${contenu.marginTopCm * PX_PAR_CM * zoom}px ${contenu.marginRightCm * PX_PAR_CM * zoom}px ${contenu.marginBottomCm * PX_PAR_CM * zoom}px ${contenu.marginLeftCm * PX_PAR_CM * zoom}px`,
          fontSize: `${zoom}em`,
        }}
      >
        {(contenu.hasHeader || contenu.hasFooter) && (
          <p className="artifact-note-entete">
            {contenu.hasHeader && contenu.hasFooter ? "En-tête et pied de page conservés"
              : contenu.hasHeader ? "En-tête conservé" : "Pied de page conservé"}
          </p>
        )}
        {contenu.blocs.map((b) => (
          <BlocDocx key={b.id} b={b} actif={enSurbrillance.has(b.id)} onCliquer={onCliquer}
            sessionId={vue.sessionId} revision={vue.revision} />
        ))}
      </div>
    </div>
  );
}

/**
 * Le rang affiché dans la marge — et la LETTRE qui dit de quoi c'est le rang.
 *
 * Paragraphes, tableaux et images sont numérotés SÉPARÉMENT : « supprime le 3ᵉ paragraphe » et
 * « le tableau 1 » ne comptent pas la même chose. Une marge qui n'afficherait que des chiffres
 * les empilerait dans une seule colonne — « 1 2 3 4 » puis « 1 » pour le tableau qui suit —, et
 * la personne qui les lit à voix haute n'aurait aucun moyen de savoir de quel « 1 » elle parle.
 *
 * Le préfixe rend l'espace de numérotation visible : `T1` est le premier tableau, `I1` la
 * première image, `3` le troisième paragraphe. C'est ce que §17 demande — que le numéro affiché
 * soit celui qu'on prononce.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'IMAGE DU DOCUMENT, VRAIMENT AFFICHÉE.
 *
 * Un cadre gris disant « Image — 4,0 × 2,0 cm » n'est pas un rendu : la personne ne peut pas
 * distinguer le logo de 2019 de celui de 2027, donc elle ne peut pas VÉRIFIER ce qu'Adam vient
 * de faire — et « c'est fait » redevient une parole à croire, ce qu'aucun écran de ce produit
 * n'a le droit de demander.
 *
 * La révision est dans l'URL : sans elle, le navigateur re-servirait l'image d'AVANT le
 * remplacement, et la personne croirait que rien ne s'est passé (même raison que pour les pages
 * de PDF). Si les octets ne se servent pas — format inconnu, image liée et non incorporée — le
 * `<img>` échoue et l'on RETOMBE sur le cadre, avec sa taille : montrer un cadre vide sans rien
 * dire ferait croire à une image blanche.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
function ImageDocument({ sessionId, revision, id, alt, largeurPx, hauteurPx }: {
  sessionId: string; revision: number; id: string; alt: string;
  largeurPx: number; hauteurPx: number;
}) {
  const [casse, setCasse] = React.useState(false);
  const style = { width: `${largeurPx}px`, height: `${hauteurPx}px` } as React.CSSProperties;
  if (casse) {
    return (
      <div className="artifact-image-cadre" style={style}>
        <span>{alt || "Image"} — aperçu indisponible</span>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- octets servis à la volée, hors optimiseur Next.
    <img
      src={`/api/artifact/${sessionId}/image/${encodeURIComponent(id)}?r=${revision}`}
      alt={alt || "Image du document"}
      className="artifact-image"
      style={style}
      onError={() => setCasse(true)}
    />
  );
}

function BlocDocx({ b, actif, onCliquer, sessionId, revision }: {
  b: BlocVue; actif: boolean; onCliquer: (id: string) => void; sessionId: string; revision: number;
}) {
  const classe = `artifact-bloc${actif ? " artifact-bloc-actif" : ""}`;
  const prefixe = b.type === "tableau" ? "T" : b.type === "image" ? "I" : "";
  const quoi = b.type === "tableau" ? "Tableau" : b.type === "image" ? "Image" : "Paragraphe";
  // Le rang s'affiche dans la marge : c'est ainsi que « supprime le troisième paragraphe »
  // devient vérifiable À L'ŒIL, avant d'être exécuté.
  const rang = (
    <span className="artifact-rang" aria-hidden="true" title={`${quoi} ${b.index}`}>{prefixe}{b.index}</span>
  );

  if (b.type === "tableau") {
    return (
      <div className={classe} data-id={b.id} onClick={() => onCliquer(b.id)} role="presentation">
        {rang}
        <table className="artifact-tableau">
          <tbody>
            {b.lignes.map((ligne, i) => (
              <tr key={i}>{ligne.map((c, j) => (i === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>))}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (b.type === "image") {
    return (
      <div className={classe} data-id={b.id} onClick={() => onCliquer(b.id)} role="presentation">
        {rang}
        <ImageDocument sessionId={sessionId} revision={revision} id={b.id} alt={b.texte}
          largeurPx={(b.largeurCm ?? 4) * PX_PAR_CM} hauteurPx={(b.hauteurCm ?? 3) * PX_PAR_CM} />
      </div>
    );
  }
  return (
    <div className={classe} data-id={b.id} onClick={() => onCliquer(b.id)} role="presentation">
      {rang}
      <p style={styleDuBloc(b)}>{b.texte || " "}</p>
    </div>
  );
}

// ─────────────────────────── PDF ───────────────────────────

export function ScenePdf({ vue, contenu, zoom, onPage }: {
  vue: VueArtefact; contenu: VuePdf; zoom: number; onPage: (p: number) => void;
}) {
  const active = vue.activePage ?? 1;
  const page = contenu.pages.find((p) => p.index === active) ?? contenu.pages[0];
  if (!page) return <p className="artifact-vide">Ce PDF n&apos;a plus aucune page.</p>;

  // La révision est dans l'URL : sans elle, le navigateur re-servirait l'image d'AVANT la
  // suppression, et la personne croirait que rien ne s'est passé.
  const src = `/api/artifact/${vue.sessionId}/page/${page.index}?r=${vue.revision}`;
  return (
    <div className="artifact-pdf">
      <nav className="artifact-miniatures" aria-label="Pages">
        {contenu.pages.map((p) => (
          <button key={p.id} type="button"
            className={`artifact-miniature${p.index === active ? " artifact-miniature-active" : ""}`}
            onClick={() => onPage(p.index)} aria-current={p.index === active}>
            <span className="artifact-miniature-num">{p.index}</span>
            <span className="artifact-miniature-texte">{p.apercu || "—"}</span>
          </button>
        ))}
      </nav>
      <div className="artifact-pdf-page">
        <div className="artifact-pdf-nav">
          <button type="button" className="artifact-bouton" disabled={active <= 1} onClick={() => onPage(active - 1)} aria-label="Page précédente">
            <ChevronLeft size={15} />
          </button>
          <span>Page {active} sur {contenu.pages.length}</span>
          <button type="button" className="artifact-bouton" disabled={active >= contenu.pages.length} onClick={() => onPage(active + 1)} aria-label="Page suivante">
            <ChevronRight size={15} />
          </button>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element -- image générée à la volée, hors optimiseur Next. */}
        <img src={src} alt={`Page ${page.index}`} className="artifact-pdf-image"
          style={{ width: `${Math.min(100, 100 * zoom)}%`, transform: page.rotation ? `rotate(${page.rotation}deg)` : undefined }} />
      </div>
    </div>
  );
}

// ─────────────────────────── PowerPoint ───────────────────────────

export function ScenePptx({ vue, contenu, zoom, onDiapo, onForme }: {
  vue: VueArtefact; contenu: VuePptx; zoom: number; onDiapo: (d: number) => void; onForme: (id: string) => void;
}) {
  const active = vue.activeSlide ?? 1;
  const diapo = contenu.diapos.find((d) => d.index === active) ?? contenu.diapos[0];
  if (!diapo) return <p className="artifact-vide">Cette présentation n&apos;a plus de diapositive.</p>;
  const enSurbrillance = new Set(vue.surbrillance);
  const largeur = contenu.largeurCm * PX_PAR_CM * zoom * 0.55;
  const echelle = largeur / (contenu.largeurCm * PX_PAR_CM);

  return (
    <div className="artifact-pptx">
      <nav className="artifact-miniatures artifact-miniatures-diapos" aria-label="Diapositives">
        {contenu.diapos.map((d) => (
          <button key={d.id} type="button"
            className={`artifact-miniature${d.index === active ? " artifact-miniature-active" : ""}${enSurbrillance.has(d.id) ? " artifact-miniature-neuve" : ""}`}
            data-id={d.id}
            onClick={() => onDiapo(d.index)} aria-current={d.index === active}>
            <span className="artifact-miniature-num">{d.index}</span>
            <span className="artifact-miniature-texte">{d.titre || "Sans titre"}</span>
          </button>
        ))}
      </nav>
      <div className="artifact-diapo-cadre">
        <div className={`artifact-diapo${enSurbrillance.has(diapo.id) ? " artifact-diapo-neuve" : ""}`} data-id={diapo.id} key={diapo.id}
          style={{ width: `${largeur}px`, height: `${contenu.hauteurCm * PX_PAR_CM * echelle}px` }}>
          {diapo.formes.map(placerSansCadre(contenu, diapo.titre, diapo.formes)).map((f) => (
            <div key={f.id}
              className={`artifact-forme${enSurbrillance.has(f.id) ? " artifact-forme-active" : ""}`}
              data-role={f.role} data-id={f.id}
              onClick={() => onForme(f.id)} role="presentation"
              style={{
                left: `${f.xCm * PX_PAR_CM * echelle}px`,
                top: `${f.yCm * PX_PAR_CM * echelle}px`,
                width: `${f.largeurCm * PX_PAR_CM * echelle}px`,
                height: `${f.hauteurCm * PX_PAR_CM * echelle}px`,
                // La taille de police suit l'échelle de la diapositive : sinon un titre de 32 pt
                // déborderait d'une miniature réduite et l'aperçu mentirait.
                fontSize: f.style.sizePt ? `${f.style.sizePt * echelle}pt` : undefined,
                fontWeight: f.style.bold ? 700 : undefined,
                fontStyle: f.style.italic ? "italic" : undefined,
                fontFamily: f.style.font ? `"${f.style.font}", system-ui, sans-serif` : undefined,
                color: f.style.color ? `#${f.style.color}` : undefined,
                textAlign: (f.align ?? undefined) as React.CSSProperties["textAlign"],
              }}>
              {f.role === "picture"
                ? (
                  <ImageDocument sessionId={vue.sessionId} revision={vue.revision} id={f.id} alt={f.nom}
                    largeurPx={f.largeurCm * PX_PAR_CM * echelle} hauteurPx={f.hauteurCm * PX_PAR_CM * echelle} />
                )
                : f.role === "chart" ? <span className="artifact-forme-media">Graphique</span>
                  : f.role === "table" ? <span className="artifact-forme-media">Tableau</span>
                    : f.texte}
            </div>
          ))}
        </div>
        <p className="artifact-legende">Diapositive {active} sur {contenu.diapos.length}</p>
      </div>
    </div>
  );
}

/**
 * UNE FORME SANS CADRE PROPRE — un espace réservé qui hérite sa position de la DISPOSITION (une diapositive ajoutée
 * par l'Atelier, un deck qui s'appuie sur ses masques). Le modèle la lit à 0 × 0 : dessinée telle quelle, son texte
 * disparaissait. On la pose là où une disposition « Titre et contenu » la met — le titre en haut, le corps dessous.
 */
function placerSansCadre(contenu: VuePptx, titreDiapo: string, formes: VuePptx["diapos"][number]["formes"]) {
  // Le haut de la première zone qui a SON cadre : le titre se loge au-dessus, sans la recouvrir.
  const haut = Math.min(contenu.hauteurCm * 0.24, ...formes.filter((x) => x.largeurCm > 0 && x.hauteurCm > 0).map((x) => x.yCm));
  return (f: VuePptx["diapos"][number]["formes"][number]) => {
    if (f.largeurCm > 0 && f.hauteurCm > 0) return f;
    const titre = Boolean(titreDiapo) && f.texte === titreDiapo;
    const hTitre = Math.max(1, Math.min(contenu.hauteurCm * 0.15, haut * 0.9));
    return {
      ...f,
      xCm: contenu.largeurCm * 0.06, largeurCm: contenu.largeurCm * 0.88,
      yCm: titre ? Math.max(0, (haut - hTitre) / 2) : contenu.hauteurCm * 0.24, hauteurCm: titre ? hTitre : contenu.hauteurCm * 0.66,
      style: titre && !f.style.sizePt ? { ...f.style, sizePt: 28, bold: true } : f.style,
    };
  };
}

// ─────────────────────────── Excel ───────────────────────────

const COLONNES_VUE_MAX = 26;
const LIGNES_VUE_MAX = 60;

export function SceneXlsx({ vue, contenu, onFeuille, onCellule }: {
  vue: VueArtefact; contenu: VueXlsx; onFeuille: (f: string) => void; onCellule: (id: string) => void;
}) {
  const nomActif = vue.activeSheet ?? contenu.feuilles[0]?.nom ?? "";
  const feuille = contenu.feuilles.find((f) => f.nom === nomActif) ?? contenu.feuilles[0];
  if (!feuille) return <p className="artifact-vide">Ce classeur n&apos;a aucune feuille.</p>;

  const parRef = new Map(feuille.cellules.map((c) => [c.ref, c]));
  const nbLignes = Math.min(Math.max(feuille.lignes, 1), LIGNES_VUE_MAX);
  const nbColonnes = Math.min(Math.max(feuille.colonnes, 1), COLONNES_VUE_MAX);
  const lettre = (n: number) => {
    let s = "";
    let v = n;
    while (v > 0) { const r = (v - 1) % 26; s = String.fromCharCode(65 + r) + s; v = Math.floor((v - r) / 26); }
    return s;
  };
  const selection = vue.surbrillance[0] ?? null;
  // Plusieurs cellules touchées (un tableau posé, un remplacement) : toutes sont surlignées, la première est « active ».
  const surlignees = new Set(vue.surbrillance);
  const cellSelection = selection ? feuille.cellules.find((c) => c.id === selection) : null;

  return (
    <div className="artifact-xlsx">
      <div className="artifact-onglets" role="tablist">
        {contenu.feuilles.map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={f.nom === feuille.nom}
            className={`artifact-onglet${f.nom === feuille.nom ? " artifact-onglet-actif" : ""}`}
            onClick={() => onFeuille(f.nom)}>{f.nom}</button>
        ))}
      </div>
      <div className="artifact-formule">
        <span className="artifact-formule-ref">{cellSelection?.ref ?? "—"}</span>
        <span className="artifact-formule-valeur">{cellSelection?.formule ?? cellSelection?.valeur ?? ""}</span>
      </div>
      <div className="artifact-grille-cadre">
        <table className="artifact-grille">
          <thead>
            <tr>
              <th className="artifact-coin" />
              {Array.from({ length: nbColonnes }, (_, i) => (
                <th key={i} style={{ width: feuille.largeurs[i] ? `${feuille.largeurs[i]! * 8}px` : undefined }}>{lettre(i + 1)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: nbLignes }, (_, r) => (
              <tr key={r} className={r < feuille.figeLignes ? "artifact-ligne-figee" : undefined}>
                <th className="artifact-entete-ligne">{r + 1}</th>
                {Array.from({ length: nbColonnes }, (_, c) => {
                  const ref = `${lettre(c + 1)}${r + 1}`;
                  const cel = parRef.get(ref);
                  return (
                    <td key={c} data-ref={ref}
                      className={cel && cel.id === selection ? "artifact-cellule-active" : cel && surlignees.has(cel.id) ? "artifact-cellule-surlignee" : undefined}
                      data-id={cel?.id}
                      onClick={() => cel && onCellule(cel.id)}
                      style={cel ? {
                        fontWeight: cel.style.bold ? 700 : undefined,
                        fontStyle: cel.style.italic ? "italic" : undefined,
                        color: cel.style.color ? `#${cel.style.color}` : undefined,
                        background: cel.fond ? `#${cel.fond}` : undefined,
                        textAlign: (cel.align ?? undefined) as React.CSSProperties["textAlign"],
                      } : undefined}>
                      {cel?.valeur ?? ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {feuille.images.length > 0 && (
        /**
         * LES IMAGES DE LA FEUILLE, EN BANDE — et pourquoi PAS posées sur la grille.
         *
         * La grille est un APERÇU : les largeurs de colonnes y sont approchées, et les lignes
         * ont toutes la même hauteur. Superposer les images à leur position calculée les
         * placerait donc à côté de leur vraie cellule, et la personne corrigerait un décalage
         * qui n'existe que dans l'aperçu. On les montre à part, chacune avec SA cellule écrite
         * — ce qui répond à la seule question qu'on se pose : « laquelle, et où ? ».
         */
        <div className="artifact-images-feuille">
          {feuille.images.map((i) => (
            <button key={i.id} type="button" className="artifact-image-vignette"
              onClick={() => onCellule(i.id)} title={i.nom}>
              <ImageDocument sessionId={vue.sessionId} revision={vue.revision} id={i.id} alt={i.nom}
                largeurPx={Math.min(140, i.largeurCm * PX_PAR_CM)}
                hauteurPx={Math.min(140, i.largeurCm * PX_PAR_CM) * (i.hauteurCm / Math.max(0.01, i.largeurCm))} />
              <span className="artifact-image-ancre">{i.ancre ?? `image ${i.index}`}</span>
            </button>
          ))}
        </div>
      )}
      {(feuille.lignes > LIGNES_VUE_MAX || feuille.colonnes > COLONNES_VUE_MAX) && (
        <p className="artifact-legende">
          Aperçu des {nbLignes} premières lignes et {nbColonnes} premières colonnes — la feuille
          en compte {feuille.lignes} × {feuille.colonnes}. Les modifications portent sur la feuille entière.
        </p>
      )}
    </div>
  );
}
