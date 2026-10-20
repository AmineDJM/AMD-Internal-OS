"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import {
  Download, Trash2, RotateCcw, Pencil, Loader2, Check, FolderInput, UserPlus, MoreHorizontal, Scale, Mails, Share2,
  MessageSquare, FileDown, Upload, History, ListPlus, Maximize2, Minimize2,
} from "lucide-react";
import {
  renameNode, trashNode, restoreNode, deleteNode, moveNode, getDriveNodeShares, getDriveNodeVersions, convertNodeToPdf,
} from "@/lib/actions/drive-actions";
import { listDriveComments } from "@/lib/actions/drive-comment-actions";
import { entreesMenu, iconesLigne, libellePartage, pastilleCompteur, type EntreeMenu } from "@/lib/drive/menu-fichier";
import { explorerSize } from "@/lib/drive/explorer";
import { formatDateTime } from "@/lib/utils";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Select } from "@/components/ui/input";
import { SharePanel, type ShareItem } from "./[id]/share-panel";
import { DriveComments, type DriveCommentItem } from "./[id]/drive-comments";
import { useNouvelleVersion } from "./nouvelle-version";
import { BoutonTelecharger } from "@/components/telechargement/bouton-telecharger";
import { useRafraichir } from "@/components/shared/use-rafraichir";

// Panneaux rares : chargés au premier clic, pour que le fichier ouvert ne les embarque pas avant l'éditeur.
const SendToLegalSheet = dynamic(() => import("./send-to-legal").then((m) => m.SendToLegalSheet), { ssr: false });
const SendToMailSheet = dynamic(() => import("./send-to-mail").then((m) => m.SendToMailSheet), { ssr: false });
const PartagerSheet = dynamic(() => import("@/components/shared/partager-button").then((m) => m.PartagerSheet), { ssr: false });

interface MoveTarget { id: string; name: string }
interface UserLite { id: string; name: string }

interface Props {
  id: string;
  name: string;
  isFile: boolean;
  canEdit: boolean;
  /** Le propriétaire — EN TÊTE du menu, avec les autres renseignements du fichier. */
  owner?: string;
  trash?: boolean;
  /** Dossiers de destination pour « Déplacer » (présent = action disponible). */
  moveTargets?: MoveTarget[];
  /** Personnes avec qui partager, si la page les a déjà ; sinon le panneau les charge à l'ouverture. */
  users?: UserLite[];
  /** Catégorie courante (racine) : transmise au déplacement pour préserver l'espace de destination. */
  spaceId?: string | null;
  /** Taille, type et date lisibles — l'en-tête du menu. */
  infos?: { sizeLabel?: string; typeLabel?: string; updatedLabel?: string };
  /** Compteurs : partages (icône colorée), commentaires (pastille), versions (en-tête). */
  counts?: { shares: number; comments: number; versions: number };
  /** « Convertir en PDF » proposé (format Office, convertisseur configuré, droit de créer). */
  convertible?: boolean;
  /** Le FICHIER OUVERT : on revient au dossier après la corbeille, et le menu sait basculer en plein écran. */
  ouvert?: {
    retour: string;
    pleinEcran?: { actif: boolean; basculer: () => void };
    /** Les champs personnalisés du fichier, s'il en existe : rendus dans un panneau. */
    champs?: React.ReactNode;
  };
}

/** Panneau « Partage » d'un nœud — qui a accès, et avec quel rôle (Lecture, Éditeur, Aucun accès). */
function AccessSheet({ nodeId, name, users, open, onClose }: { nodeId: string; name: string; users?: UserLite[]; open: boolean; onClose: () => void }) {
  const [loading, setLoading] = React.useState(true);
  const [shares, setShares] = React.useState<ShareItem[]>([]);
  const [candidats, setCandidats] = React.useState<UserLite[]>(users ?? []);
  const [canEdit, setCanEdit] = React.useState(false);

  const load = React.useCallback(() => {
    // Les personnes à qui partager ne sont demandées que si la page ne les a pas déjà.
    getDriveNodeShares(nodeId, !users).then((r) => {
      if (r.ok) {
        setShares(r.shares ?? []);
        setCanEdit(r.canEdit ?? false);
        if (!users) setCandidats(r.users ?? []);
      }
      setLoading(false);
    });
  }, [nodeId, users]);

  React.useEffect(() => { if (open) { setLoading(true); load(); } }, [open, load]);

  return (
    <Sheet open={open} onClose={onClose} title={`Partage — « ${name} »`} description="Lecture : voir. Éditeur : modifier. Sur un dossier, l'accès descend sur tout son contenu." width="md">
      {loading
        ? <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : <SharePanel nodeId={nodeId} users={candidats} shares={shares} canEdit={canEdit} onChanged={load} />}
    </Sheet>
  );
}

/** Panneau « Commentaires » — le fil du fichier, lu à l'ouverture du panneau. */
function CommentsSheet({ nodeId, name, open, onClose }: { nodeId: string; name: string; open: boolean; onClose: () => void }) {
  const [comments, setComments] = React.useState<DriveCommentItem[] | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const load = React.useCallback(() => {
    listDriveComments(nodeId).then((r) => {
      if (r.ok) { setComments(r.comments ?? []); setErr(null); } else setErr(r.error ?? "Lecture impossible.");
    });
  }, [nodeId]);
  React.useEffect(() => { if (open) { setComments(null); load(); } }, [open, load]);
  return (
    <Sheet open={open} onClose={onClose} title={`Commentaires — « ${name} »`} width="md">
      {err ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>
        : comments === null ? <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          : <DriveComments nodeId={nodeId} comments={comments} onChanged={load} />}
    </Sheet>
  );
}

/** Panneau « Historique des versions ». */
function VersionsSheet({ nodeId, name, open, onClose }: { nodeId: string; name: string; open: boolean; onClose: () => void }) {
  const [versions, setVersions] = React.useState<{ id: string; version: number; size: number; createdAt: string }[] | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setVersions(null);
    getDriveNodeVersions(nodeId).then((r) => setVersions(r.ok ? r.versions ?? [] : []));
  }, [open, nodeId]);
  return (
    <Sheet open={open} onClose={onClose} title={`Historique des versions — « ${name} »`} width="md">
      {versions === null
        ? <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : versions.length === 0
          ? <p className="text-sm text-muted-foreground">Aucune version enregistrée.</p>
          : (
            <ul className="space-y-1.5 text-sm">
              {versions.map((v, i) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-x-3">
                  <span className="flex items-center gap-2">v{v.version}{i === 0 && <Badge tone="success" dot={false}>actuelle</Badge>}</span>
                  <span className="tabular-nums text-muted-foreground">{explorerSize(v.size, true)} · {formatDateTime(v.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
    </Sheet>
  );
}

/** Une entrée du menu — même hauteur, même gabarit d'icône, quel que soit ce qu'elle déclenche. */
export function MenuItem({
  icon, label, onClick, href, download, danger, disabled, telechargement,
}: {
  icon: React.ReactNode; label: string;
  onClick?: () => void; href?: string; download?: boolean;
  danger?: boolean; disabled?: boolean;
  /** Un TÉLÉCHARGEMENT : l'entrée devient le bouton partagé (original en un clic, choix de la taille à côté). */
  telechargement?: { nom: string; archive?: boolean };
}) {
  const cls = [
    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2.5 text-left text-[0.8125rem] transition-colors sm:py-2",
    danger ? "text-destructive hover:bg-destructive/10" : "text-foreground hover:bg-secondary",
    disabled ? "pointer-events-none opacity-50" : "",
  ].join(" ");
  const body = <><span className={`shrink-0 ${danger ? "" : "text-muted-foreground"}`}>{icon}</span><span className="truncate">{label}</span></>;
  if (href && telechargement) {
    return <BoutonTelecharger href={href} nom={telechargement.nom} archive={telechargement.archive} className={`${cls} flex-1`} classeRacine="w-full">{body}</BoutonTelecharger>;
  }
  if (href) {
    return <a href={href} className={cls} {...(download ? { download: "" } : {})}>{body}</a>;
  }
  return <button type="button" onClick={onClick} className={cls} disabled={disabled}>{body}</button>;
}

/** Les icônes de la ligne — même gabarit pour les trois (au doigt : 36 px). */
const ICONE = "relative inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:h-7 sm:w-7";
const MENU_W = 240; // w-60

/**
 * LE MENU ⋯ — flottant, jamais coupé.
 *
 * Le tableau vit dans un conteneur qui masque son débordement (c'est ce qui l'empêche de pousser
 * la page de travers). Un menu posé en `absolute` dedans serait donc TRONQUÉ dès la dernière
 * ligne. Il est rendu en PORTAIL, positionné en coordonnées d'écran depuis le bouton, et remis à
 * gauche quand il déborderait à droite. Sa hauteur réelle (en-tête + entrées) est mesurée une fois
 * monté : il s'ouvre au-dessus du bouton quand il ne tient pas dessous.
 */
function Kebab({ label, onOpenChange, children }: { label: string; onOpenChange?: (open: boolean) => void; children: (close: () => void) => React.ReactNode }) {
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [open, setOpenState] = React.useState(false);
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null);

  const setOpen = React.useCallback((next: boolean) => { setOpenState(next); onOpenChange?.(next); }, [onOpenChange]);
  const close = React.useCallback(() => setOpen(false), [setOpen]);

  const place = React.useCallback((h = 320) => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
    // Sous le bouton, sauf s'il n'y a plus la place en dessous — auquel cas au-dessus.
    const top = window.innerHeight - r.bottom > h + 12 ? r.bottom + 4 : Math.max(8, r.top - 4 - h);
    setPos((p) => (p && p.top === top && p.left === left ? p : { top, left }));
  }, []);

  // Une fois le menu monté, sa VRAIE hauteur décide du côté (l'en-tête d'informations le rallonge).
  React.useLayoutEffect(() => {
    if (open && pos && menuRef.current) place(menuRef.current.offsetHeight);
  }, [open, pos, place]);

  React.useEffect(() => {
    if (!open) return;
    place();
    const onDown = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest("[data-kebab-menu]")) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    // Un défilement décroche le menu de sa ligne : on le referme plutôt que de le laisser flotter
    // à côté d'une autre ligne, ce qui ferait agir sur le mauvais fichier.
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open, place, close]);

  return (
    <>
      <button
        ref={btnRef} type="button" aria-label={label} title="Plus d'actions" aria-haspopup="menu" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className={`${ICONE} ${open ? "bg-secondary text-foreground" : ""}`}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && pos && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          data-kebab-menu
          role="menu"
          style={{ top: pos.top, left: pos.left }}
          className="fixed z-50 max-h-[calc(100dvh-1rem)] w-60 overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-xl animate-fade-in"
          onClick={(e) => e.stopPropagation()}
        >
          {children(close)}
        </div>,
        document.body,
      )}
    </>
  );
}

function InfoLigne({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium tabular-nums text-foreground" title={value}>{value}</span>
    </div>
  );
}

/**
 * LES ACTIONS D'UN FICHIER — trois icônes, partout pareilles : PARTAGE, COMMENTAIRES, ⋯.
 *
 * Dans la liste comme dans le fichier ouvert (Direction, 10/2026 — « comme Google Drive »). Le partage et les
 * commentaires ont leur icône parce qu'on y revient sans cesse ; tout le reste vit dans le menu, en tête duquel
 * se lisent les informations du fichier (propriétaire, taille, type, date, versions, partage).
 *
 * Rien n'est chargé d'avance : les partages, les versions et le fil de commentaires se lisent à l'ouverture de
 * LEUR panneau. Ouvrir un fichier ne doit rien attendre qui ne s'affiche pas.
 *
 * Les panneaux sont rendus par la LIGNE, jamais par le menu : le menu est un portail démonté à sa fermeture
 * (garde-fou `menu-portal-guard.test.ts`). La confirmation de corbeille, elle, vit DANS le menu : elle n'a pas
 * à survivre à sa fermeture — fermer, c'est annuler.
 */
export function NodeActions({ id, name, isFile, canEdit, owner, trash, moveTargets, users, spaceId, infos, counts, convertible, ouvert }: Props) {
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  const [renaming, setRenaming] = React.useState(false);
  const [moving, setMoving] = React.useState(false);
  const [sharing, setSharing] = React.useState(false);
  const [commenting, setCommenting] = React.useState(false);
  const [history, setHistory] = React.useState(false);
  const [fields, setFields] = React.useState(false);
  // Les panneaux « Déclarer dans Legal » et « Classer en courrier » sont pilotés ICI, pas par
  // l'entrée de menu : le menu est un portail démonté à la fermeture, et un panneau rendu par
  // lui disparaissait dans le même clic.
  const [legal, setLegal] = React.useState(false);
  const [mail, setMail] = React.useState(false);
  const [partage, setPartage] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [moveErr, setMoveErr] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<null | "corbeille" | "supprimer">(null);
  const [toast, setToast] = React.useState<string | null>(null);
  const versionInput = React.useRef<HTMLInputElement>(null);
  const envoyerVersion = useNouvelleVersion();
  // On ne peut pas déplacer un dossier dans lui-même.
  const targets = (moveTargets ?? []).filter((t) => t.id !== id);
  const icones = iconesLigne({ isFile, trash: Boolean(trash) });
  const groupes = entreesMenu({
    isFile, canEdit, trash: Boolean(trash), convertible: Boolean(convertible),
    peutDeplacer: Boolean(moveTargets) && targets.length > 0, ouvert: Boolean(ouvert), champs: Boolean(ouvert?.champs),
  });
  const nbComments = pastilleCompteur(counts?.comments ?? 0);

  const dire = (texte: string) => { setToast(texte); window.setTimeout(() => setToast(null), 4500); };

  /** Une action serveur simple (corbeille, restauration, suppression) lancée depuis le menu. */
  const run = async (action: (fd: FormData) => Promise<{ ok: boolean; error?: string } | unknown>, close: () => void, quitter = false) => {
    close();
    setPending(true);
    const fd = new FormData();
    fd.set("id", id);
    const r = (await action(fd)) as { ok?: boolean; error?: string } | undefined;
    setPending(false);
    if (r && r.ok === false) { dire(r.error ?? "Action impossible."); return; }
    // Le fichier ouvert vient de partir à la corbeille : on retourne à son dossier.
    if (quitter && ouvert) { router.push(ouvert.retour); return; }
    rafraichir();
  };

  const convertir = async (close: () => void) => {
    close();
    setPending(true);
    const fd = new FormData();
    fd.set("id", id);
    const r = await convertNodeToPdf(fd);
    setPending(false);
    if (r.ok && r.id) router.push(`/drive/${r.id}`);
    else dire(r.error ?? "Conversion impossible.");
  };

  const entree = (e: EntreeMenu, close: () => void): React.ReactNode => {
    const ic = "h-3.5 w-3.5";
    switch (e) {
      case "pdf": return <MenuItem key={e} icon={<FileDown className={ic} />} label="Convertir en PDF" onClick={() => void convertir(close)} />;
      case "version": return <MenuItem key={e} icon={<Upload className={ic} />} label="Nouvelle version" onClick={() => { close(); versionInput.current?.click(); }} />;
      case "historique": return <MenuItem key={e} icon={<History className={ic} />} label="Historique des versions" onClick={() => { close(); setHistory(true); }} />;
      case "telecharger": return <MenuItem key={e} icon={<Download className={ic} />} label={isFile ? "Télécharger" : "Télécharger (ZIP)"} href={`/api/drive/${id}/raw?dl=1`} telechargement={{ nom: name, archive: !isFile }} />;
      case "renommer": return <MenuItem key={e} icon={<Pencil className={ic} />} label="Renommer" onClick={() => { close(); setRenaming(true); }} />;
      case "deplacer": return <MenuItem key={e} icon={<FolderInput className={ic} />} label="Déplacer" onClick={() => { close(); setMoveErr(null); setMoving(true); }} />;
      // PARTAGER PAR LA MESSAGERIE — ouvert à QUI VOIT : « envoie-moi ce dossier » est une lecture qu'on
      // relaie ; le serveur confronte la pièce aux droits Drive réels de l'expéditeur. Pas dans la
      // corbeille : la pièce partirait sans le fichier (`parseDriveRefs` écarte les nœuds corbeillés).
      case "messagerie": return <MenuItem key={e} icon={<Share2 className={ic} />} label="Partager par messagerie" onClick={() => { close(); setPartage(true); }} />;
      // VERS LEGAL / LES COURRIERS — référence sans copie : le fichier RESTE ici.
      case "legal": return <MenuItem key={e} icon={<Scale className={ic} />} label="Déclarer dans Legal" onClick={() => { close(); setLegal(true); }} />;
      case "courrier": return <MenuItem key={e} icon={<Mails className={ic} />} label="Classer en courrier" onClick={() => { close(); setMail(true); }} />;
      case "champs": return <MenuItem key={e} icon={<ListPlus className={ic} />} label="Champs personnalisés" onClick={() => { close(); setFields(true); }} />;
      case "plein-ecran": return ouvert?.pleinEcran
        ? <MenuItem key={e} icon={ouvert.pleinEcran.actif ? <Minimize2 className={ic} /> : <Maximize2 className={ic} />} label={ouvert.pleinEcran.actif ? "Quitter le plein écran" : "Plein écran"} onClick={() => { close(); ouvert.pleinEcran?.basculer(); }} />
        : null;
      // LA CORBEILLE DEMANDE CONFIRMATION — dans le menu même : un clic de travers ne fait plus rien partir.
      case "corbeille": return <MenuItem key={e} icon={<Trash2 className={ic} />} label="Mettre à la corbeille" danger onClick={() => setConfirm("corbeille")} />;
      case "restaurer": return <MenuItem key={e} icon={<RotateCcw className={ic} />} label="Restaurer" onClick={() => void run(restoreNode, close)} />;
      case "supprimer": return <MenuItem key={e} icon={<Trash2 className={ic} />} label="Supprimer définitivement" danger onClick={() => setConfirm("supprimer")} />;
    }
  };

  return (
    <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
      {pending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin text-muted-foreground" />}

      {icones.partage && (
        <button
          type="button" onClick={() => setSharing(true)}
          title={`Partage — ${libellePartage(counts?.shares ?? 0)}`} aria-label={`Gérer le partage — ${name}`}
          className={`${ICONE} ${(counts?.shares ?? 0) > 0 ? "text-primary" : ""}`}
        >
          <UserPlus className="h-4 w-4" />
        </button>
      )}
      {icones.commentaires ? (
        <button type="button" onClick={() => setCommenting(true)} title="Commentaires" aria-label={`Commentaires — ${name}${nbComments ? ` (${nbComments})` : ""}`} className={ICONE}>
          <MessageSquare className="h-4 w-4" />
          {nbComments && (
            <span className="absolute -right-0.5 -top-0.5 min-w-[1rem] rounded-full bg-primary px-1 text-center text-[0.5625rem] font-semibold leading-4 text-primary-foreground">{nbComments}</span>
          )}
        </button>
      ) : (
        // Un dossier n'a pas de fil : la place reste, pour que les « ⋯ » s'alignent d'une ligne à l'autre.
        !trash && <span className="inline-block h-9 w-9 sm:h-7 sm:w-7" aria-hidden />
      )}

      <Kebab label={`Actions — ${name}`} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        {(close) => confirm ? (
          <div className="space-y-2.5 p-2.5" role="alertdialog" aria-label="Confirmation">
            <p className="text-[0.8125rem] font-medium [overflow-wrap:anywhere]">
              {confirm === "corbeille" ? `Mettre « ${name} » à la corbeille ?` : `Supprimer définitivement « ${name} » ?`}
            </p>
            <p className="text-xs text-muted-foreground">
              {confirm === "corbeille" ? "Il reste restaurable depuis la Corbeille." : "Cette suppression ne peut pas être annulée."}
            </p>
            {/* Empilés sur toute la largeur : côte à côte, ils débordaient du menu. */}
            <div className="flex flex-col gap-1.5">
              <Button
                type="button" size="sm" variant="destructive" autoFocus className="w-full"
                onClick={() => void (confirm === "corbeille" ? run(trashNode, close, true) : run(deleteNode, close))}
              >
                <Trash2 className="h-3.5 w-3.5" /> {confirm === "corbeille" ? "Mettre à la corbeille" : "Supprimer"}
              </Button>
              <Button type="button" size="sm" variant="outline" className="w-full" onClick={() => setConfirm(null)}>Annuler</Button>
            </div>
          </div>
        ) : (
          <>
            {!trash && (
              <div className="space-y-1 border-b border-border px-2.5 pb-2 pt-1.5 text-[0.75rem]">
                {owner && <InfoLigne label="Propriétaire" value={owner} />}
                {isFile && infos?.sizeLabel && <InfoLigne label="Taille" value={infos.sizeLabel} />}
                {isFile && infos?.typeLabel && <InfoLigne label="Type" value={infos.typeLabel} />}
                {infos?.updatedLabel && <InfoLigne label="Modifié" value={infos.updatedLabel} />}
                {isFile && counts && <InfoLigne label="Versions" value={String(Math.max(1, counts.versions))} />}
                {counts && <InfoLigne label="Partage" value={libellePartage(counts.shares)} />}
              </div>
            )}
            <div className="pt-1">
              {groupes.length === 0 && <p className="px-2.5 py-2 text-xs text-muted-foreground">Aucune action.</p>}
              {groupes.map((g, i) => (
                <React.Fragment key={g.join("-")}>
                  {i > 0 && <div className="my-1 border-t border-border" />}
                  {g.map((e) => entree(e, close))}
                </React.Fragment>
              ))}
            </div>
          </>
        )}
      </Kebab>

      {/* Tout ce qui doit SURVIVRE au clic du menu est rendu ici, par la ligne. */}
      {isFile && canEdit && (
        <input
          ref={versionInput} type="file" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) envoyerVersion(id, f); e.target.value = ""; }}
        />
      )}

      <Sheet open={renaming} onClose={() => setRenaming(false)} title="Renommer" width="md">
        <form action={async (fd) => { setSaving(true); await renameNode(fd); setSaving(false); setRenaming(false); rafraichir(); }} className="space-y-3">
          <input type="hidden" name="id" value={id} />
          <div className="space-y-1.5">
            <Label htmlFor={`name-${id}`}>Nouveau nom</Label>
            <Input id={`name-${id}`} name="name" defaultValue={name} required />
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setRenaming(false)}>Annuler</Button>
            <Button type="submit" disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Renommer</Button>
          </div>
        </form>
      </Sheet>

      <Sheet open={moving} onClose={() => !saving && setMoving(false)} title={`Déplacer « ${name} »`} width="md">
        <form
          action={async (fd) => {
            setSaving(true); setMoveErr(null);
            const r = await moveNode(fd);
            setSaving(false);
            if (r.ok) { setMoving(false); rafraichir(); }
            else setMoveErr(r.error ?? "Déplacement impossible.");
          }}
          className="space-y-3"
        >
          <input type="hidden" name="id" value={id} />
          {spaceId && <input type="hidden" name="spaceId" value={spaceId} />}
          <div className="space-y-1.5">
            <Label htmlFor={`target-${id}`}>Dossier de destination</Label>
            <Select id={`target-${id}`} name="targetId" defaultValue="">
              {targets.map((t) => <option key={t.id || "root"} value={t.id}>{t.name}</option>)}
            </Select>
          </div>
          {moveErr && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{moveErr}</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setMoving(false)} disabled={saving}>Annuler</Button>
            <Button type="submit" disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderInput className="h-4 w-4" />} Déplacer</Button>
          </div>
        </form>
      </Sheet>

      {icones.partage && <AccessSheet nodeId={id} name={name} users={users} open={sharing} onClose={() => setSharing(false)} />}
      {icones.commentaires && <CommentsSheet nodeId={id} name={name} open={commenting} onClose={() => setCommenting(false)} />}
      {isFile && <VersionsSheet nodeId={id} name={name} open={history} onClose={() => setHistory(false)} />}
      {ouvert?.champs && (
        <Sheet open={fields} onClose={() => setFields(false)} title={`Champs personnalisés — « ${name} »`} width="md">
          {ouvert.champs}
        </Sheet>
      )}

      {partage && (
        <PartagerSheet
          open={partage}
          onClose={() => setPartage(false)}
          refType="DRIVE_NODE"
          refId={id}
          refLabel={name}
          driveNodeIds={[id]}
          href={`/drive/${id}`}
        />
      )}
      {isFile && legal && <SendToLegalSheet open={legal} nodeId={id} name={name} onClose={() => setLegal(false)} />}
      {isFile && mail && <SendToMailSheet open={mail} nodeId={id} name={name} onClose={() => setMail(false)} />}

      {toast && typeof document !== "undefined" && createPortal(
        <p role="alert" className="fixed bottom-4 left-1/2 z-[60] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg bg-destructive px-3 py-2 text-sm text-destructive-foreground shadow-lg">
          {toast}
        </p>,
        document.body,
      )}
    </div>
  );
}
