"use client";

import * as React from "react";
import { Share2, Loader2, Check, User, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import type { EntityType } from "@prisma/client";
import { partagerParMessagerie, listerDestinatairesPartage, type GroupePartage } from "@/lib/actions/partage-actions";
import { libelleDuType } from "@/lib/partage";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Textarea, Label, Input } from "@/components/ui/input";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PARTAGER PAR LA MESSAGERIE — le MÊME panneau dans Legal, Courriers, Ad&Pro, Regulatory, Drive.
 *
 * Il ne connaît aucun module : on lui donne ce qu'on partage (un type + un identifiant, et/ou
 * des nœuds du Drive) et il s'occupe du reste. C'est ce qui garantit qu'ajouter le partage à un
 * sixième écran ne demande pas d'écrire une sixième fois la vérification des droits — elle vit
 * une seule fois, côté serveur, dans `partagerParMessagerie`.
 *
 * Il n'importe que `@/lib/partage`, module PUR : la frontière client/serveur de ce dépôt casse
 * les déploiements quand un composant `"use client"` tire Prisma par un import ordinaire.
 *
 * ── DEUX PIÈCES, ET IL EN FALLAIT DEUX ──────────────────────────────────────────────────
 *
 * `PartagerSheet` est le panneau seul, PILOTÉ de l'extérieur (`open` / `onClose`) ; `Partager
 * Button` y ajoute le bouton qui l'ouvre. Le menu « … » du Drive est un PORTAIL démonté à la
 * fermeture : un panneau rendu par une de ses entrées disparaîtrait dans le même clic — le
 * dépôt le sait déjà (« Déclarer dans Legal » et « Classer en courrier » sont pilotés depuis
 * la ligne, pas depuis le menu). Un composant qui ne sait qu'être son propre déclencheur ne
 * peut donc pas entrer dans un menu, et le Drive est précisément l'écran où le partage se fait
 * depuis un menu.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export interface PersonnePartage { id: string; name: string; role?: string | null; recent?: boolean }

export interface CiblePartage {
  refType?: EntityType;
  refId?: string;
  /** Le nom LISIBLE de l'objet — celui que le destinataire verra dans son fil. */
  refLabel?: string;
  /** Les pièces du Drive jointes au partage. Le serveur les confronte aux droits réels. */
  driveNodeIds?: readonly string[];
  /** L'adresse de l'objet dans l'ERP, pour que le destinataire y aille en un clic. */
  href?: string;
  /**
   * Les personnes proposées. OMIS, l'annuaire interne est chargé À L'OUVERTURE du panneau.
   *
   * C'est ce qui rend le partage posable sur une LIGNE de tableau sans faire descendre
   * l'annuaire dans chaque page, chaque table et chaque ligne — pour une liste que personne
   * n'ouvre dans la très grande majorité des visites. Un écran qui connaît une liste PLUS
   * PERTINENTE (les responsables d'un événement) la fournit et rien n'est chargé.
   */
  people?: readonly PersonnePartage[];
  /** Le message proposé — « Est-ce toujours d'actualité ? A-t-elle été payée ? » (Direction, 06/10). Modifiable. */
  noteInitiale?: string;
}

/** Ce qu'on annonce dans le panneau : le nom de l'objet, sinon sa nature. */
function nommer({ refLabel, driveNodeIds, refType }: CiblePartage): string {
  if (refLabel) return refLabel;
  if (driveNodeIds && driveNodeIds.length > 0) return `${driveNodeIds.length} élément(s) du Drive`;
  return libelleDuType(refType);
}

/**
 * LE PANNEAU SEUL — ouvert et fermé par l'appelant.
 *
 * Il ne se monte pas tant qu'il n'est pas ouvert : posé sur les lignes d'un tableau de deux
 * cents dossiers, deux cents formulaires cachés coûteraient un écran lent pour une liste que
 * personne n'ouvre.
 */
export function PartagerSheet({ open, onClose, ...cible }: CiblePartage & { open: boolean; onClose: () => void }) {
  const { refType, refId, refLabel, driveNodeIds, href, people } = cible;
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  // UN GROUPE OU UN COLLÈGUE (Direction, 06/10) : un seul destinataire, choisi dans l'un des deux onglets.
  const [onglet, setOnglet] = React.useState<"GROUPE" | "COLLEGUE">("COLLEGUE");
  const [choix, setChoix] = React.useState<{ type: "GROUPE" | "COLLEGUE"; id: string } | null>(null);
  const [filtre, setFiltre] = React.useState("");
  const [annuaire, setAnnuaire] = React.useState<readonly PersonnePartage[] | null>(people ?? null);
  const [groupes, setGroupes] = React.useState<readonly GroupePartage[] | null>(null);
  const [chargement, setChargement] = React.useState(false);

  // Les groupes et les collègues se chargent à la PREMIÈRE ouverture, une seule fois par panneau monté. La demande est
  // marquée PARTIE dans une ref : mettre `chargement` dans les dépendances annulait la réponse au rendu suivant — le
  // panneau restait sur « Chargement… » pour toujours (Direction, 06/10).
  const demande = React.useRef(false);
  const monte = React.useRef(true);
  React.useEffect(() => () => { monte.current = false; }, []);
  React.useEffect(() => {
    if (!open || demande.current) return;
    demande.current = true;
    setChargement(true);
    listerDestinatairesPartage()
      .then((r) => {
        if (!monte.current) return;
        if (r.ok) { setGroupes(r.groupes); if (!people) setAnnuaire(r.people); }
        else { setGroupes([]); setAnnuaire(people ?? []); setErr(r.error ?? "La messagerie n'a pas pu être chargée."); }
      })
      .catch(() => { if (monte.current) { setGroupes([]); setErr("La messagerie n'a pas pu être chargée — réessayez."); demande.current = false; } })
      .finally(() => { if (monte.current) setChargement(false); });
  }, [open, people]);

  const quoi = nommer(cible);
  const q = filtre.trim().toLowerCase();
  // PAS TOUT L'ANNUAIRE : d'emblée, les collègues avec qui on échange déjà ; les autres apparaissent quand on cherche.
  const collegues = React.useMemo(() => {
    const tous = people ?? annuaire ?? [];
    if (q.length >= 2) return tous.filter((p) => p.name.toLowerCase().includes(q) || (p.role ?? "").toLowerCase().includes(q)).slice(0, 30);
    return people ? tous : tous.filter((p) => p.recent);
  }, [people, annuaire, q]);
  const groupesVisibles = React.useMemo(
    () => (groupes ?? []).filter((g) => !q || g.title.toLowerCase().includes(q)),
    [groupes, q],
  );

  const ligne = (on: boolean) => `flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors ${on ? "bg-primary/10 text-foreground" : "hover:bg-muted"}`;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Partager par messagerie"
      description={`« ${quoi} » sera envoyé dans la messagerie interne, à un groupe ou à un collègue. Les pièces du Drive deviennent lisibles pour les destinataires.`}
      width="md"
    >
      <form
        action={async (fd) => {
          if (!choix) return;
          setBusy(true); setErr(null);
          fd.set(choix.type === "GROUPE" ? "groupeId" : "collegueId", choix.id);
          if (refType) fd.set("refType", refType);
          if (refId) fd.set("refId", refId);
          if (refLabel) fd.set("refLabel", refLabel);
          if (href) fd.set("href", href);
          if (driveNodeIds && driveNodeIds.length > 0) fd.set("driveRefs", JSON.stringify([...driveNodeIds]));
          try {
            const r = await partagerParMessagerie(fd);
            if (r.ok) {
              onClose(); setChoix(null);
              // On EMMÈNE la personne dans le fil : « c'est parti » sans pouvoir le vérifier
              // est une parole à croire, et aucun écran de ce produit n'a le droit de le demander.
              if (r.conversationId) router.push(`/messages?c=${r.conversationId}`);
              else rafraichir();
            } else setErr(r.error ?? "Le partage n'a pas pu être envoyé.");
          } catch {
            setErr(actionFailureMessage("THROWN"));
          } finally {
            setBusy(false);
          }
        }}
        className="space-y-4"
      >
        <div className="space-y-1.5">
          <div className="flex gap-1 rounded-md bg-muted p-1" role="tablist" aria-label="Destinataire">
            {(["COLLEGUE", "GROUPE"] as const).map((o) => (
              <button
                key={o} type="button" role="tab" aria-selected={onglet === o} onClick={() => setOnglet(o)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-2 text-sm sm:py-1.5 ${onglet === o ? "bg-card font-medium shadow-sm" : "text-muted-foreground"}`}
              >
                {o === "COLLEGUE" ? <User className="h-3.5 w-3.5" /> : <Users className="h-3.5 w-3.5" />} {o === "COLLEGUE" ? "Un collègue" : "Un groupe"}
              </button>
            ))}
          </div>
          <Input
            value={filtre}
            onChange={(e) => setFiltre(e.target.value)}
            placeholder={onglet === "COLLEGUE" ? "Chercher un collègue par son nom…" : "Filtrer les groupes…"}
          />
          <div className="max-h-56 overflow-y-auto rounded-md border border-input">
            {chargement && (
              <p className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Chargement…
              </p>
            )}
            {!chargement && onglet === "COLLEGUE" && collegues.length === 0 && (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                {q.length >= 2 ? "Aucun collègue ne correspond." : "Tapez au moins deux lettres du nom d'un collègue."}
              </p>
            )}
            {!chargement && onglet === "GROUPE" && groupesVisibles.length === 0 && (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                {(groupes ?? []).length === 0 ? "Vous n'êtes membre d'aucun groupe de la messagerie." : "Aucun groupe ne correspond."}
              </p>
            )}
            {!chargement && onglet === "COLLEGUE" && collegues.map((p) => {
              const on = choix?.type === "COLLEGUE" && choix.id === p.id;
              return (
                <button type="button" key={p.id} onClick={() => setChoix(on ? null : { type: "COLLEGUE", id: p.id })} aria-pressed={on} className={ligne(on)}>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{p.name}</span>
                    {p.role && <span className="block truncate text-xs text-muted-foreground">{p.role}</span>}
                  </span>
                  {on && <Check className="h-4 w-4 shrink-0 text-primary" />}
                </button>
              );
            })}
            {!chargement && onglet === "GROUPE" && groupesVisibles.map((g) => {
              const on = choix?.type === "GROUPE" && choix.id === g.id;
              return (
                <button type="button" key={g.id} onClick={() => setChoix(on ? null : { type: "GROUPE", id: g.id })} aria-pressed={on} className={ligne(on)}>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{g.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{g.memberCount} membre{g.memberCount > 1 ? "s" : ""}</span>
                  </span>
                  {on && <Check className="h-4 w-4 shrink-0 text-primary" />}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Message (optionnel)</Label>
          <Textarea name="note" rows={3} defaultValue={cible.noteInitiale} placeholder="Pourquoi vous le partagez, ce que vous attendez…" />
        </div>

        {err && <p className="text-sm text-destructive">{err}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>Annuler</Button>
          <Button type="submit" disabled={busy || !choix}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Envoyer
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
export function PartagerButton({
  label, iconOnly = false, variant = "outline", size = "sm", ...cible
}: CiblePartage & {
  label?: string;
  /**
   * LIGNE DE TABLEAU : l'icône seule, avec son nom accessible.
   *
   * Une colonne de plus portant « Partager » sur dix lignes pousse le tableau hors de l'écran ;
   * un bouton sans nom accessible n'existe pas pour un lecteur d'écran. Les deux à la fois, donc.
   */
  iconOnly?: boolean;
  variant?: "outline" | "ghost" | "primary" | "secondary";
  size?: "sm" | "md" | "lg";
}) {
  const [open, setOpen] = React.useState(false);
  const quoi = nommer(cible);

  return (
    // ─────────────────────────────────────────────────────────────────────────────────────
    // LA BULLE S'ARRÊTE ICI, ET C'EST STRUCTUREL.
    //
    // Ce bouton est posé sur des LIGNES CLIQUABLES (Regulatory ouvre la fiche au clic sur la
    // ligne) et le panneau `Sheet` n'est PAS monté dans un portail : il vit dans le DOM sous la
    // ligne. Sans cette barrière, cocher un destinataire ou taper une note ferait naviguer vers
    // la fiche, panneau ouvert — c'est-à-dire un partage perdu au moment de le composer.
    //
    // La barrière vit dans le COMPOSANT, pas chez ses appelants : la poser à chaque appel
    // marcherait cinq fois et serait oubliée la sixième, et l'oubli ne se voit qu'en cliquant.
    // `display: contents` ne crée aucune boîte — la mise en page des appelants ne bouge pas,
    // et les événements remontent quand même par l'arbre DOM.
    // ─────────────────────────────────────────────────────────────────────────────────────
    <span className="contents" onClick={(e) => e.stopPropagation()}>
      <Button
        variant={variant}
        size={size}
        onClick={() => setOpen(true)}
        aria-label={iconOnly ? `Partager « ${quoi} »` : undefined}
        title={iconOnly ? `Partager « ${quoi} »` : undefined}
      >
        <Share2 className={iconOnly ? "h-3.5 w-3.5" : "h-4 w-4"} /> {iconOnly ? null : (label ?? "Partager")}
      </Button>
      {open && <PartagerSheet open={open} onClose={() => setOpen(false)} {...cible} />}
    </span>
  );
}
