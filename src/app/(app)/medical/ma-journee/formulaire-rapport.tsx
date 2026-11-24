"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, Mic, ShieldAlert, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import type { StockPourVisite } from "@/lib/queries/promo-remises";
import { BlocMaterielRemis, type RemisesInitiales } from "./materiel-remis";

/** Le service du décideur, l'an annoncé et les produits classés, avec ce qui est déjà saisi. */
export interface BesoinVue {
  annee: number;
  lieu: string;
  produits: { productId: string; nom: string; actuel: number | null }[];
}

/** Ce que la segmentation sait déjà du praticien — pour ne demander que la mise à jour du fait (§17, §18). */
export interface PotentielVue {
  metrique: string;
  productId: string | null;
  produit: string | null;
  dernier: { potentiel: number | null; sur10: number | null; le: string } | null;
}

/** Ce qui pré-remplit le formulaire quand on CORRIGE un rapport fait (§118.166). */
export interface RapportInitial {
  texte: string;
  suite: string;
  /** « Objections du médecin » (`doctorFeedback`). */
  objections?: string;
  produitIds: string[];
  messageIds: string[];
  remises: RemisesInitiales;
}

/**
 * La barre d'actions des feuilles de saisie : collée au bas de la feuille pendant qu'on défile, pour
 * que « Enregistrer » reste sous le pouce. L'ombre pleine, couleur carte, couvre la marge basse de
 * la feuille sous la barre (sinon le texte défilerait dans l'interstice).
 */
export const BARRE_ACTIONS =
  "sticky bottom-0 z-10 -mx-4 flex gap-2 border-t border-border bg-card px-4 py-3 shadow-[0_3rem_0_0_hsl(var(--card))] sm:-mx-5 sm:justify-end sm:px-5";

/**
 * LE FORMULAIRE DE RAPPORT — le même pour une visite planifiée et pour une visite hors plan, depuis « Ma journée »
 * comme depuis la grille du plan de tournée. L'écrire deux fois ferait diverger les deux saisies au premier champ
 * ajouté, et le délégué apprendrait deux gestes pour une seule chose (§118.5).
 *
 * ── TROIS CHAMPS VISIBLES, LE RESTE REPLIÉ (11/2026) ─────────────────────────────────────────
 *
 * Les trois que le rapport EXIGE sont en haut, toujours visibles : les produits (pré-cochés quand la gamme n'en
 * compte qu'un, sinon ceux que la mallette du mois met en tête), le message de la Direction Marketing, le compte rendu
 * — avec un gros bouton « Dicter ». Tout le reste — matériel remis, ce qu'il reste à faire, potentiel, besoin annuel —
 * est derrière « Plus de détails (facultatif) », ouvert d'office quand on CORRIGE un rapport qui en porte.
 *
 * ── LA DICTÉE ────────────────────────────────────────────────────────────────────────────────
 *
 * La reconnaissance vocale du navigateur remplit le champ ; si elle n'existe pas, le bouton n'est pas offert et le
 * micro du clavier reste. Annoncer une dictée qui ne marche pas est pire que ne pas l'offrir.
 */
export function FormulaireRapport({
  action, produits, produitsIncomplets, messages, sansBu, messageObligatoire, produitObligatoire, stock, initial, precoches,
  libelleEnvoi = "Enregistrer la visite", busy, err, onCancel, entete, potentiel, besoin, lienPv,
}: {
  action: (fd: FormData) => void | Promise<void>;
  /** Le potentiel que la segmentation attend de ce praticien — facultatif, la dernière valeur affichée. */
  potentiel?: PotentielVue | null;
  /** Le besoin annuel du service — facultatif, proposé quand le praticien est décideur. */
  besoin?: BesoinVue | null;
  produits: { productId: string; name: string }[];
  produitsIncomplets: string[];
  messages: { id: string; title: string; body: string | null; buName: string | null }[];
  sansBu: boolean;
  messageObligatoire: boolean;
  produitObligatoire: boolean;
  stock: StockPourVisite;
  /** Le rapport tel qu'il a été fait — pour une correction dans la fenêtre des 48 h. */
  initial?: RapportInitial | undefined;
  /** Les produits à cocher d'office hors correction (la mallette du mois) — seuls ceux de la gamme comptent. */
  precoches?: readonly string[];
  libelleEnvoi?: string;
  busy: boolean;
  err: string | null;
  onCancel: () => void;
  entete?: React.ReactNode;
  /**
   * « Signaler un effet indésirable » — l'adresse du formulaire de pharmacovigilance PRÉREMPLI avec le produit coché
   * (le premier), passée seulement à qui peut signaler. La pharmacovigilance se rattache à la visite.
   */
  lienPv?: ((produitId: string | null) => string) | null;
}) {
  const [texte, setTexte] = React.useState(initial?.texte ?? "");
  // LES PRODUITS COCHÉS sont un état : le bloc « Matériel remis » met en tête les articles de ces produits, et le
  // signalement de pharmacovigilance part avec le premier. UN SEUL PRODUIT DANS LA GAMME arrive coché (hors correction)
  // — décocher est plus rapide que chercher ; sinon, ceux de la mallette du mois.
  const [coches, setCoches] = React.useState<Set<string>>(() => {
    if (initial) return new Set(initial.produitIds);
    if (produits.length === 1 && produits[0]) return new Set([produits[0].productId]);
    const gamme = new Set(produits.map((p) => p.productId));
    return new Set((precoches ?? []).filter((id) => gamme.has(id)));
  });
  const basculer = (id: string) => setCoches((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const [dictee, setDictee] = React.useState<"absente" | "prete" | "en-cours">("absente");
  const recRef = React.useRef<{ start: () => void; stop: () => void } | null>(null);
  // LES DÉTAILS S'OUVRENT D'OFFICE quand on corrige un rapport qui en porte : les cacher ferait croire qu'ils ont disparu.
  const detailsOuverts = Boolean(initial && (initial.suite || initial.objections || initial.remises.materiel.length > 0 || initial.remises.numeriques.length > 0));

  React.useEffect(() => {
    // LA DICTÉE N'EST PAS PROMISE AVANT D'ÊTRE LÀ : la personne appuie, rien ne se passe, et elle cesse de faire
    // confiance à l'écran.
    const w = window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor() as {
      lang: string; continuous: boolean; interimResults: boolean;
      onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
      onend: () => void; start: () => void; stop: () => void;
    };
    rec.lang = "fr-FR";
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      let ajout = "";
      for (let i = 0; i < e.results.length; i += 1) ajout += `${e.results[i]![0]!.transcript} `;
      setTexte(ajout.trim());
    };
    rec.onend = () => setDictee("prete");
    recRef.current = rec;
    setDictee("prete");
  }, []);

  const basculerDictee = () => {
    if (!recRef.current) return;
    if (dictee === "en-cours") { recRef.current.stop(); setDictee("prete"); }
    else { recRef.current.start(); setDictee("en-cours"); }
  };

  const premierCoche = produits.find((p) => coches.has(p.productId))?.productId ?? null;

  return (
    <form className="space-y-4" action={action}>
      {entete}

      {/* ── 1. LES PRODUITS DE SA GAMME ─────────────────────────────────────── */}
      <div className="space-y-1.5">
        <p className="flex items-center gap-1 text-sm font-medium">
          <span>Produits présentés {produitObligatoire && <span className="text-destructive">*</span>}</span>
          {/* Ce qui manque à la gamme, dit derrière le ⓘ plutôt qu'en paragraphe (Direction, 07/10). */}
          {!sansBu && produitsIncomplets.length > 0 && (
            <InfoBulle label="Produits absents" align="left">
              {produitsIncomplets.length} produit(s) promu(s) ({produitsIncomplets.slice(0, 3).join(", ")}) ne sont rattachés
              à aucun dossier réglementaire et ne peuvent donc pas figurer dans un rapport — à rapprocher dans Produits 360
              (⋯ › « Rapprocher un produit BD / BU »).
            </InfoBulle>
          )}
        </p>
        {sansBu ? (
          <p className="flex items-center gap-1 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs">
            <span className="min-w-0 flex-1">Aucune gamme rattachée — chez votre superviseur</span>
            <InfoBulle label="Pourquoi">
              Sans Business Unit, la liste de vos produits est vide et le rapport sera refusé. Votre superviseur vous
              rattache à une gamme depuis Business Units.
            </InfoBulle>
          </p>
        ) : produits.length === 0 ? (
          <p className="rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs">Aucun produit actif dans votre gamme.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {produits.map((p) => (
              <label key={p.productId} className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm [overflow-wrap:anywhere] has-[:checked]:border-primary has-[:checked]:bg-primary/5 sm:min-h-9 sm:gap-1.5 sm:px-2.5 sm:py-1">
                <input
                  type="checkbox" name="productId" value={p.productId}
                  checked={coches.has(p.productId)} onChange={() => basculer(p.productId)}
                  className="h-5 w-5 shrink-0 rounded border-input sm:h-4 sm:w-4"
                />
                {p.name}
              </label>
            ))}
          </div>
        )}
      </div>

      {/* ── 2. LES MESSAGES DE LA DIRECTION MARKETING ───────────────────────── */}
      <div className="space-y-1.5">
        <p className="flex items-center gap-1 text-sm font-medium">
          <span>Message porté {messageObligatoire && <span className="text-destructive">*</span>}</span>
          {messageObligatoire && (
            <InfoBulle label="Pourquoi obligatoires" align="left">
              Produits et messages sont exigés : sans eux, ni l&apos;effort par produit ni l&apos;efficacité d&apos;un message
              ne se mesurent — c&apos;est ce que la Direction demande de savoir.
            </InfoBulle>
          )}
        </p>
        {messages.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-2.5 text-xs text-muted-foreground">
            {messageObligatoire
              ? "Aucun message publié pour votre gamme — chez la Direction Marketing (rapport refusé sans message)"
              : "Aucun message publié pour votre gamme."}
          </p>
        ) : (
          // Au téléphone, la liste ne s'enferme pas dans une petite boîte défilante : défiler dans un
          // défilement, au pouce, fait manquer des messages. Elle s'y range à partir de la tablette.
          <div className="space-y-1 rounded-lg border border-border p-1.5 sm:max-h-44 sm:overflow-y-auto sm:p-2">
            {messages.map((m) => (
              <label key={m.id} className="flex items-start gap-2.5 rounded-md px-2 py-2.5 text-sm hover:bg-secondary has-[:checked]:bg-primary/5 sm:gap-2 sm:px-1 sm:py-1">
                <input type="checkbox" name="messageId" value={m.id} defaultChecked={initial?.messageIds.includes(m.id) ?? false} className="mt-0.5 h-5 w-5 shrink-0 rounded border-input sm:h-4 sm:w-4" />
                <span className="min-w-0">
                  <span className="font-medium">{m.title}</span>
                  {m.body && <span className="block text-xs text-muted-foreground">{m.body}</span>}
                  {m.buName && <span className="block text-xs text-muted-foreground">Gamme {m.buName}</span>}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* ── 3. LE COMPTE RENDU — vocal ou écrit ──────────────────────────────── */}
      <div className="space-y-1.5">
        <Label htmlFor="rapport-texte">Compte rendu <span className="text-destructive">*</span></Label>
        {/* Sans dictée sur ce navigateur, pas de bouton — et pas de phrase pour le dire. */}
        {dictee !== "absente" && (
          <Button
            type="button" variant={dictee === "en-cours" ? "destructive" : "outline"} onClick={basculerDictee}
            className="h-12 w-full text-base sm:h-10 sm:w-auto sm:text-sm"
          >
            {dictee === "en-cours" ? <><Square className="h-4 w-4" /> Arrêter la dictée</> : <><Mic className="h-5 w-5" /> Dicter</>}
          </Button>
        )}
        <Textarea
          id="rapport-texte" name="report" rows={5} required
          value={texte} onChange={(e) => setTexte(e.target.value)}
          placeholder="Ce que le médecin a dit, ses objections, ce qu'il attend."
        />
        {/* LA TRANSCRIPTION VOYAGE À PART quand elle vient du micro : elle crée un rapport
            vocal (`FieldReport`) rattaché à la visite, avec sa propre relecture. */}
        {dictee !== "absente" && <input type="hidden" name="transcript" value={dictee === "prete" && texte ? texte : ""} />}
      </div>

      {/* ── PLUS DE DÉTAILS (facultatif) — replié : la saisie reste « trois champs » ─────────── */}
      <details className="group rounded-lg border border-border" open={detailsOuverts}>
        <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium sm:min-h-9">
          Plus de détails <span className="ml-1 font-normal text-muted-foreground">(facultatif)</span>
        </summary>
        <div className="space-y-3 border-t border-border p-3">
          {/* LE MATÉRIEL REMIS (§118.166) — une remise faite ici sort du stock comme partout ailleurs. */}
          <BlocMaterielRemis stock={stock} produitsCoches={coches} initial={initial?.remises} />

          {/* LES OBJECTIONS DU MÉDECIN — le champ `doctorFeedback` que le rapport porte déjà, et que l'IA lit avec le texte. */}
          <div>
            <Label htmlFor="rapport-objections">Objections du médecin</Label>
            <Input id="rapport-objections" name="doctorFeedback" defaultValue={initial?.objections ?? ""} placeholder="« Trop cher pour mes patients non assurés »" />
          </div>

          <div>
            <Label htmlFor="rapport-suite">Ce qu&apos;il reste à faire</Label>
            <Input id="rapport-suite" name="followUpActions" defaultValue={initial?.suite ?? ""} placeholder="Rappeler après le comité du 12, envoyer l'étude…" />
          </div>

          {/* ── LE POTENTIEL (Segmentation Studio) — facultatif : le fait, AMD calcule la conséquence ─── */}
          {potentiel && (
            <div className="space-y-1.5 rounded-lg border border-border p-2.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Potentiel</p>
              <p className="text-xs text-muted-foreground">
                {potentiel.dernier
                  ? `Dernière valeur : ${potentiel.dernier.potentiel ?? "—"} ${potentiel.metrique}${potentiel.dernier.sur10 !== null ? `, ${potentiel.dernier.sur10}/10 sous ${potentiel.produit ?? "le produit"}` : ""} — ${new Date(potentiel.dernier.le).toLocaleDateString("fr-FR")}.`
                  : "Jamais renseigné."}
              </p>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                <div className="min-w-0"><Label htmlFor="pot-patients" className="text-xs">{potentiel.metrique}</Label><Input id="pot-patients" name="potentielPatients" inputMode="decimal" className="w-full sm:w-28" /></div>
                {potentiel.productId && <div className="min-w-0"><Label htmlFor="pot-sur10" className="text-xs">Sur 10, sous {potentiel.produit}</Label><Input id="pot-sur10" name="potentielSur10" inputMode="decimal" className="w-full sm:w-28" /></div>}
              </div>
              {potentiel.productId && <input type="hidden" name="potentielProduitId" value={potentiel.productId} />}
            </div>
          )}

          {/* ── LE BESOIN ANNUEL DU SERVICE (décideur) — facultatif : ce qu'il annonce fixe le volume de l'AO ─── */}
          {besoin && besoin.produits.length > 0 && (
            <div className="space-y-1.5 rounded-lg border border-border p-2.5">
              <p className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <span>Besoin annuel du service {besoin.annee}</span>
                <InfoBulle label="Besoin annuel du service" align="left" className="normal-case tracking-normal">
                  Le décideur fixe les prévisions de son service ({besoin.lieu}), qui fixent le volume de l&apos;appel d&apos;offres.
                  Notez les boîtes qu&apos;il annonce pour {besoin.annee} ; une case vide ne change rien.
                </InfoBulle>
              </p>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                {besoin.produits.map((p) => (
                  <div key={p.productId} className="min-w-0">
                    <input type="hidden" name="besoinProduitId" value={p.productId} />
                    <Label htmlFor={`besoin-${p.productId}`} className="text-xs">{p.nom} (boîtes)</Label>
                    <Input id={`besoin-${p.productId}`} name="besoinQuantite" inputMode="numeric" className="w-full sm:w-32"
                      placeholder={p.actuel !== null ? p.actuel.toLocaleString("fr-FR") : ""} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </details>

      {/* LA PHARMACOVIGILANCE SE RATTACHE À LA VISITE (Super Admin, 11/2026) : un bouton bordé, pas un lien ambre perdu
          hors de la visite — et il part prérempli (praticien, établissement, produit coché, jour de la visite). */}
      {lienPv && (
        // Un nouvel onglet : le compte rendu en cours reste là, intact, pendant qu'on signale.
        <Link
          href={lienPv(premierCoche)} target="_blank" rel="noopener"
          className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-warning/60 px-3 text-sm font-medium text-foreground hover:bg-warning/10 sm:min-h-9 sm:w-auto"
        >
          <ShieldAlert className="h-4 w-4 text-warning" aria-hidden /> Signaler un effet indésirable
        </Link>
      )}

      {err && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
      <div className={BARRE_ACTIONS}>
        <Button type="button" variant="outline" className="h-12 flex-1 sm:h-10 sm:flex-none" onClick={onCancel} disabled={busy}>Annuler</Button>
        <Button type="submit" className="h-12 min-w-0 flex-[2] sm:h-10 sm:flex-none" disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} <span className="truncate">{libelleEnvoi}</span>
        </Button>
      </div>
    </form>
  );
}
