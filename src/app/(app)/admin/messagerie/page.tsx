import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { DELETE_REGISTRY } from "@/lib/admin-delete-registry";
import { ADMIN_TABS } from "@/lib/labels";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { BackLink } from "@/components/shared/back-link";
import { EmptyState } from "@/components/shared/empty-state";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SuperAdminDeleteButton } from "@/components/shared/super-admin-delete";

export const dynamic = "force-dynamic";

/** Plafond des deux listes : le TOTAL voyage avec l'échantillon, et la coupe se DIT. */
const MAX_LIGNES = 200;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ADMINISTRATION › MESSAGERIE & NOTIFICATIONS — Super Admin uniquement.
 *
 * POURQUOI CET ÉCRAN EXISTE, et pourquoi il ne pouvait pas être un bouton dans la messagerie :
 * la LECTURE de la messagerie est cloisonnée par APPARTENANCE (`getConversationDetail` rend
 * `null` à qui n'est pas membre, `getConversationSummaries` part de ses propres adhésions).
 * Un Super Admin qui n'est pas dans un groupe ne le VOIT donc nulle part — il ne pouvait pas
 * le supprimer faute de pouvoir l'atteindre. Un groupe créé par erreur restait vivant.
 *
 * CE QUE CET ÉCRAN MONTRE, ET CE QU'IL NE MONTRE PAS. Des MÉTADONNÉES seulement : type, nom,
 * nombre de membres, nombre de messages, dernière activité, auteur. Jamais un corps de message,
 * jamais un aperçu. Ouvrir le CONTENU des conversations privées depuis l'administration serait
 * une décision de permission qui appartient à la Direction, pas une conséquence technique de ce
 * lot (§118.86) — et un écran d'administration qui donne accidentellement la lecture est une
 * porte dérobée (§118.7). Un message précis se retire donc depuis la conversation, par une
 * personne qui y a déjà accès.
 *
 * LES TÊTE-À-TÊTE NE SONT PAS LISTÉS : le registre les REFUSE (`CONVERSATION.refuse`), donc les
 * afficher offrirait un bouton qui refuse — une fausse promesse pire que l'absence.
 *
 * LA SUPPRESSION passe par le patron canonique (`superAdminDelete` → instantané → corbeille →
 * restaurable → audit), le MÊME que les 27 autres types et le même que celui d'Adam : y écrire
 * une seconde logique de suppression en ferait une vérité concurrente qui prendrait du retard
 * au premier correctif (§118.5).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export default async function AdminMessageriePage(props: { searchParams: Promise<{ qui?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") redirect("/mon-espace");

  const qui = searchParams.qui?.trim() || null;

  const [conversations, totalConversations, notifications, totalNotifications, personnes] = await Promise.all([
    prisma.conversation.findMany({
      // Jamais les tête-à-tête : le registre les refuse, donc l'écran ne les propose pas.
      where: { type: { in: ["GROUP", "CHANNEL"] } },
      orderBy: { lastMessageAt: "desc" },
      take: MAX_LIGNES,
      select: {
        id: true, type: true, title: true, isArchived: true, lastMessageAt: true,
        createdBy: { select: { name: true } },
        _count: { select: { members: true, messages: true } },
      },
    }),
    prisma.conversation.count({ where: { type: { in: ["GROUP", "CHANNEL"] } } }),
    prisma.notification.findMany({
      where: qui ? { userId: qui } : {},
      orderBy: { createdAt: "desc" },
      take: MAX_LIGNES,
      select: {
        id: true, title: true, body: true, isRead: true, popup: true, createdAt: true,
        user: { select: { id: true, name: true } },
      },
    }),
    prisma.notification.count({ where: qui ? { userId: qui } : {} }),
    // L'annuaire du filtre : seuls les comptes qui ONT des notifications — proposer les autres
    // ferait choisir un filtre dont on sait déjà qu'il ne rendra rien.
    prisma.user.findMany({
      where: { notifications: { some: {} } },
      orderBy: { name: "asc" },
      select: { id: true, name: true, _count: { select: { notifications: true } } },
    }),
  ]);

  const dateFr = (d: Date) => d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const quiNom = qui ? personnes.find((p) => p.id === qui)?.name ?? null : null;

  return (
    <div className="space-y-5">
      <BackLink href="/admin">
        <ArrowLeft className="h-4 w-4" /> Administration
      </BackLink>
      <PageHeader
        title="Messagerie & notifications"
        description="Supprimer un groupe, un canal ou une notification reçue. Chaque suppression est réversible depuis la corbeille et inscrite au journal. Métadonnées seulement : aucun corps de message n'est lu ici."
      />
      <ModuleTabs tabs={ADMIN_TABS.map((t) => ({ label: t.label, href: t.href, show: userCan(user, t.module, "VIEW") }))} />

      {/* ─────────────────────────── Groupes & canaux ─────────────────────────── */}
      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Groupes &amp; canaux</h2>
          <p className="text-xs text-muted-foreground">
            {totalConversations} au total
            {totalConversations > conversations.length && ` — les ${conversations.length} plus récemment actifs sont affichés`}
            {" · "}les tête-à-tête ne sont pas supprimables
          </p>
        </div>
        {conversations.length === 0 ? (
          <div className="p-4">
            <EmptyState icon="MessagesSquare" title="Aucun groupe ni canal" description="Les groupes et canaux de la messagerie interne apparaîtront ici." />
          </div>
        ) : (
          <Table mobileCards>
            <TableHeader>
              <TableRow>
                <TableHead>Nom</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Membres</TableHead>
                <TableHead className="text-right">Messages</TableHead>
                <TableHead>Dernière activité</TableHead>
                <TableHead>Créé par</TableHead>
                <TableHead className="text-right">Supprimer</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {conversations.map((c) => (
                <TableRow key={c.id}>
                  <TableCell label="Nom" className="font-medium">
                    <span>
                      {c.title?.trim() || <span className="italic text-muted-foreground">sans titre</span>}
                      {c.isArchived && <Badge tone="neutral" className="ml-2">Archivé</Badge>}
                    </span>
                  </TableCell>
                  <TableCell label="Type">
                    <Badge tone={c.type === "CHANNEL" ? "info" : "neutral"}>{c.type === "CHANNEL" ? "Canal" : "Groupe"}</Badge>
                  </TableCell>
                  <TableCell label="Membres" className="text-right tabular-nums">{c._count.members}</TableCell>
                  <TableCell label="Messages" className="text-right tabular-nums">{c._count.messages}</TableCell>
                  <TableCell label="Dernière activité" className="whitespace-nowrap text-muted-foreground">{dateFr(c.lastMessageAt)}</TableCell>
                  <TableCell label="Créé par" className="text-muted-foreground">{c.createdBy?.name ?? "—"}</TableCell>
                  <TableCell label="Supprimer" className="text-right">
                    <SuperAdminDeleteButton
                      kind="CONVERSATION"
                      id={c.id}
                      name={`${c.type === "CHANNEL" ? "Canal" : "Groupe"} « ${c.title?.trim() || "sans titre"} » — ${c._count.members} membre(s), ${c._count.messages} message(s)`}
                      enabled
                      compact
                      stay
                      warning={DELETE_REGISTRY.CONVERSATION.reserve}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* ─────────────────────────── Notifications reçues ─────────────────────────── */}
      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Notifications reçues</h2>
            <p className="text-xs text-muted-foreground">
              Supprimée, la notification disparaît de la liste de son destinataire.
              {" "}{totalNotifications} {quiNom ? `pour ${quiNom}` : "au total"}
              {totalNotifications > notifications.length && ` — les ${notifications.length} plus récentes sont affichées`}
            </p>
          </div>
          {/* Filtre sans JavaScript : un formulaire GET, donc il fonctionne aussi quand la
              page est rendue côté serveur seul. */}
          <form method="get" className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <label htmlFor="qui" className="text-xs text-muted-foreground">Destinataire</label>
            <select
              id="qui" name="qui" defaultValue={qui ?? ""}
              className="h-10 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-base sm:h-9 sm:flex-none sm:text-sm"
            >
              <option value="">Tous</option>
              {personnes.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p._count.notifications})</option>
              ))}
            </select>
            <button type="submit" className="h-10 rounded-md border border-border px-3 text-sm font-medium hover:bg-secondary sm:h-9">
              Filtrer
            </button>
          </form>
        </div>
        {notifications.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon="Bell"
              title={quiNom ? `Aucune notification pour ${quiNom}` : "Aucune notification"}
              description="Les notifications reçues par les comptes apparaîtront ici."
            />
          </div>
        ) : (
          <Table mobileCards>
            <TableHeader>
              <TableRow>
                <TableHead>Destinataire</TableHead>
                <TableHead>Titre</TableHead>
                <TableHead>État</TableHead>
                <TableHead>Reçue le</TableHead>
                <TableHead className="text-right">Supprimer</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {notifications.map((n) => (
                <TableRow key={n.id}>
                  <TableCell label="Destinataire" className="font-medium whitespace-nowrap">{n.user.name}</TableCell>
                  <TableCell label="Titre">
                    <span>
                      <span className="font-medium">{n.title}</span>
                      {n.body && <span className="block text-xs text-muted-foreground sm:ml-2 sm:inline">{n.body.length > 90 ? `${n.body.slice(0, 90)}…` : n.body}</span>}
                    </span>
                  </TableCell>
                  <TableCell label="État">
                    <span>
                      <Badge tone={n.isRead ? "neutral" : "warning"}>{n.isRead ? "Lue" : "Non lue"}</Badge>
                      {n.popup && <Badge tone="info" className="ml-2">Pop-up</Badge>}
                    </span>
                  </TableCell>
                  <TableCell label="Reçue le" className="whitespace-nowrap text-muted-foreground">{dateFr(n.createdAt)}</TableCell>
                  <TableCell label="Supprimer" className="text-right">
                    <SuperAdminDeleteButton
                      kind="NOTIFICATION"
                      id={n.id}
                      name={`« ${n.title} » — reçue par ${n.user.name} le ${dateFr(n.createdAt)}`}
                      enabled
                      compact
                      stay
                      warning="Son destinataire ne la verra plus. Elle reste restaurable depuis la corbeille."
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
