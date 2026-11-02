"use client";

import * as React from "react";
import Link from "next/link";

import { Share2 } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { QUICK_ACCESS, TRASH_ENTRY } from "@/lib/drive/explorer";
import { moveNodes } from "@/lib/actions/drive-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

interface SpaceLite { id: string; name: string; icon: string | null; canManage: boolean }
interface UserLite { id: string; name: string }

/**
 * LE VOLET DE NAVIGATION — la colonne de gauche d'un explorateur : LES EMPLACEMENTS, et rien
 * d'autre.
 *
 * Il a porté un temps l'arborescence complète, et c'était une erreur. Un dossier de travail
 * contient vite quarante sous-dossiers — « 1.1 Req_Info », « 1.2 Spec_info », « 1.10 Meet »… —
 * et la colonne devenait un mur qu'il fallait faire défiler pour atteindre la Corbeille. Un
 * dossier se trouve DANS son emplacement, à droite, comme dans n'importe quel explorateur : la
 * colonne de gauche dit où l'on est, la liste de droite dit ce qu'il y a.
 *
 * Restent les deux gestes qui n'ont de sens que là :
 *   • **le dépôt** — on attrape un fichier dans la liste et on le lâche sur « Téléchargements »
 *     ou sur une catégorie, en un seul geste, sans naviguer d'abord jusqu'à la destination ;
 *   • **les accès d'une catégorie** (clic droit), parce que c'est là qu'on y pense.
 *
 * L'autorisation n'est JAMAIS décidée ici : `moveNodes` tranche côté
 * serveur. Une entrée de trop ne donne aucun droit — elle donnerait un refus.
 */
export function ExplorerNav({
  active, spaces, users = [],
}: {
  /** Clé de l'entrée courante : `recent`, `root`, `trash` ou un id de catégorie. */
  active: string;
  spaces: SpaceLite[];
  /** Personnes avec qui partager (hors soi-même) — vide = pas de partage depuis le volet. */
  users?: UserLite[];
}) {
  const { rafraichir } = useRafraichir();
  const [over, setOver] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [menu, setMenu] = React.useState<{ x: number; y: number; id: string; name: string } | null>(null);

  React.useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", close); };
  }, [menu]);

  /** Dépose le nœud glissé dans un dossier (`targetId`) ou à la racine d'un emplacement. */
  const drop = React.useCallback(async (e: React.DragEvent, opts: { targetId?: string; spaceId?: string | null; label: string }) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(null);
    // La liste peut porter TOUTE une sélection : on ne déplace pas une ligne sur cinq.
    const many = (e.dataTransfer.getData("text/drive-nodes") || "").split(",").filter(Boolean);
    const ids = many.length > 0 ? many : [e.dataTransfer.getData("text/drive-node")].filter(Boolean);
    if (ids.length === 0) return;
    setMsg({ ok: true, text: `Déplacement vers ${opts.label}…` });
    const fd = new FormData();
    for (const id of ids) fd.append("id", id);
    fd.set("targetId", opts.targetId ?? "");
    fd.set("spaceId", opts.spaceId ?? "");
    try {
      const r = await moveNodes(fd);
      setMsg(r.ok ? { ok: true, text: `${r.done} élément(s) déplacé(s) vers ${opts.label}.` } : { ok: false, text: r.error ?? "Déplacement impossible." });
      if (r.ok) rafraichir();
    } catch {
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
    }
    window.setTimeout(() => setMsg(null), 3000);
  }, [rafraichir]);

  const dropProps = (key: string, opts: { targetId?: string; spaceId?: string | null; label: string }) => ({
    onDragEnter: (e: React.DragEvent) => { e.preventDefault(); setOver(key); },
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(key); },
    onDragLeave: () => setOver((o) => (o === key ? null : o)),
    onDrop: (e: React.DragEvent) => { void drop(e, opts); },
  });

  // La fluidité d'un glisser-déposer tient d'abord à la TAILLE de la cible et à la netteté du
  // retour visuel : une ligne haute de 22 px qu'on doit viser au pixel donne l'impression que
  // « ça ne marche pas », alors que c'est le geste qui rate.
  const rowClass = (key: string, isActive: boolean) =>
    `group flex cursor-pointer items-center gap-1.5 rounded-lg py-2 pr-2 text-sm transition-colors ${
      over === key ? "bg-primary/20 ring-2 ring-inset ring-primary"
        : isActive ? "bg-primary/10 font-medium text-primary" : "text-foreground hover:bg-secondary"
    }`;

  const ctxProps = (id: string, name: string) => ({
    onContextMenu: (e: React.MouseEvent) => {
      if (users.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      setMenu({ x: Math.min(e.clientX, window.innerWidth - 200), y: Math.min(e.clientY, window.innerHeight - 120), id, name });
    },
  });

  // SOUS lg, le volet devient UNE RANGÉE QUI GLISSE : en colonne, il repoussait les fichiers
  // d'un écran entier au téléphone. Les intitulés de section et les retraits n'y servent plus.
  return (
    <nav className="surface no-scrollbar flex w-full shrink-0 items-center gap-1 overflow-x-auto p-2 lg:block lg:w-64 lg:overflow-visible" aria-label="Emplacements du Drive">
      <p className="hidden px-2 pb-1 pt-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground lg:block">Accès rapide</p>
      <ul className="flex shrink-0 gap-1 lg:block lg:space-y-0.5">
        {QUICK_ACCESS.map((e) => {
          // « Téléchargements » est l'espace personnel : on y dépose comme dans un vrai dossier.
          const isRoot = e.key === "root";
          return (
            <li key={e.key} className="shrink-0">
              <div
                className={rowClass(e.key, active === e.key)}
                style={{ paddingLeft: "0.5rem" }}
                {...(isRoot ? dropProps(e.key, { spaceId: "", label: "Téléchargements" }) : {})}
              >
                <span className="hidden w-4 shrink-0 lg:block" />
                <Link href={e.href} className="flex min-w-0 flex-1 items-center gap-1.5">
                  <Icon name={e.icon} className="h-4 w-4 shrink-0 opacity-80" />
                  <span className="truncate">{e.label}</span>
                </Link>
              </div>
            </li>
          );
        })}
      </ul>

      {spaces.length > 0 && (
        <>
          <p className="hidden px-2 pb-1 pt-3 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground lg:block">Catégories</p>
          <ul className="flex shrink-0 gap-1 border-l border-border pl-1 lg:block lg:space-y-0.5 lg:border-0 lg:pl-0">
            {spaces.map((s) => (
              <li key={s.id} className="max-w-[14rem] shrink-0 lg:max-w-none">
                <div
                  className={rowClass(s.id, active === s.id)}
                  style={{ paddingLeft: "0.5rem" }}
                  {...dropProps(s.id, { spaceId: s.id, label: `catégorie « ${s.name} »` })}
                  {...ctxProps(s.id, s.name)}
                >
                  <span className="hidden w-4 shrink-0 lg:block" />
                  <Link href={`/drive/espace/${s.id}`} className="flex min-w-0 flex-1 items-center gap-1.5">
                    <Icon name={s.icon || "FolderOpen"} className="h-4 w-4 shrink-0 opacity-80" />
                    <span className="truncate">{s.name}</span>
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="shrink-0 border-l border-border pl-1 lg:mt-2 lg:border-l-0 lg:border-t lg:pl-0 lg:pt-2">
        <Link
          href={TRASH_ENTRY.href}
          className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-2 text-sm lg:py-1.5 ${active === "trash" ? "bg-primary/10 font-medium text-primary" : "text-foreground hover:bg-secondary"}`}
        >
          <span className="hidden w-4 shrink-0 lg:block" />
          <Icon name={TRASH_ENTRY.icon} className="h-4 w-4 shrink-0 opacity-80" />
          {TRASH_ENTRY.label}
        </Link>
      </div>

      {msg && (
        <p className={`shrink-0 rounded-lg px-2 py-1.5 text-xs lg:mt-2 ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>{msg.text}</p>
      )}

      {menu && (
        <div
          role="menu"
          style={{ top: menu.y, left: menu.x }}
          className="fixed z-50 w-48 overflow-hidden rounded-xl border border-border bg-card py-1 shadow-lg"
        >
          {/* Une CATÉGORIE ne se partage pas nœud par nœud : ses accès (rôles + personnes) se
              règlent au même endroit que le reste de ses réglages. */}
          <Link
            href={`/drive/espace/${menu.id}`} role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary"
          >
            <Share2 className="h-4 w-4 text-muted-foreground" /> Accès de la catégorie…
          </Link>
        </div>
      )}

    </nav>
  );
}
