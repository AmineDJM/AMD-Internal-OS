import Link from "next/link";
import { Palette, Activity, Bot, Building2, Coins, Columns3, Database, Factory, FileCog,Gauge, Globe2, HardDrive, History, Layers, Library, Mail, Map as MapIcon, MessageSquare, MessagesSquare, Network, Radar, Rocket, Settings2, ShieldCheck, Trash2, Workflow, ScanSearch, DatabaseZap, ScrollText } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CreateRecordButton } from "@/components/shared/create-record-button";
import { optionsFromMap } from "@/components/shared/form-fields";
import { createUser } from "@/lib/actions/admin-actions";
import { ROLE_LABELS, ADMIN_TABS } from "@/lib/labels";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { formatAlgiers } from "@/lib/calendar-tz";
import { AuditPanel } from "./audit-panel";
import { RolesTable } from "./roles-table";
import { DriveStorageSettings } from "./drive-storage-settings";
import { StoragePanel } from "./storage-panel";
import { OnlyofficePanel } from "./onlyoffice-panel";
import { describeConfig } from "@/lib/storage/s3-config";
import { onlyofficeConfigured, onlyofficeServerUrl } from "@/lib/onlyoffice";

const GB = 1024 ** 3;
const fmtBytes = (n: number) => (n >= GB ? `${(n / GB).toFixed(2)} Go` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} Mo` : `${Math.ceil(n / 1024)} Ko`);
const fmtWhen = (d: Date) => formatAlgiers(d, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export default async function AdminPage() {
  const admin = await requireModule("ADMIN");
  const canManage = userCan(admin, "ADMIN", "CREATE");

  const [users, activeSessions, activityCount, auditCount, sessionActivity, settings] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: "asc" }, include: { _count: { select: { access: true } } } }),
    prisma.userSession.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
    prisma.activityLog.count(),
    prisma.auditLog.count(),
    // Dernière ACTIVITÉ réelle (le dernier « clic ») : max des sessions de chaque compte.
    prisma.userSession.groupBy({ by: ["userId"], _max: { lastSeenAt: true } }),
    getAppSettings(),
  ]);
  const lastClickByUser = new Map(sessionActivity.map((s) => [s.userId, s._max.lastSeenAt]));
  const lastActivityOf = (u: { id: string; lastSeenAt: Date | null; lastLoginAt: Date | null }): Date | null => {
    const candidates = [u.lastSeenAt, lastClickByUser.get(u.id) ?? null, u.lastLoginAt].filter((d): d is Date => Boolean(d));
    return candidates.length ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : null;
  };

  // Stockage Drive : consommation EXACTE — physique (dédupliquée) et par utilisateur.
  const [blobAgg, versionAgg, perOwner] = await Promise.all([
    prisma.fileBlob.aggregate({ _sum: { size: true }, _count: true }),
    prisma.fileVersion.aggregate({ _sum: { size: true } }),
    prisma.driveNode.groupBy({ by: ["ownerId"], where: { type: "FILE", isTrashed: false }, _sum: { size: true }, _count: true }),
  ]);
  const physicalBytes = blobAgg._sum.size ?? 0;
  const logicalBytes = versionAgg._sum.size ?? 0;
  const usageByOwner = new Map(perOwner.map((o) => [o.ownerId ?? "", { bytes: o._sum.size ?? 0, files: o._count }]));
  const capacityBytes = settings.driveCapacityGb * GB;
  const quotaBytes = settings.driveUserQuotaGb * GB;

  const active = users.filter((u) => u.isActive).length;

  return (
    <div className="space-y-6">
      <PageHeader title="Administration" description="Comptes, accès, sessions, activité et journal d’audit.">
        <Link href="/admin/activity">
          <Button variant="outline"><Activity className="h-4 w-4" /> Activité</Button>
        </Link>
        {admin.role === "SUPER_ADMIN" && (
          <>
            {/* Le rejeu : rembobiner la session d'une personne pour voir où ça a cassé. */}
            <Link href="/admin/replay">
              <Button variant="outline"><History className="h-4 w-4" /> Rejeu de session</Button>
            </Link>
            <Link href="/admin/access">
              <Button variant="outline"><ShieldCheck className="h-4 w-4" /> Accès par module</Button>
            </Link>
            <Link href="/admin/qualite">
              <Button variant="outline"><ScanSearch className="h-4 w-4" /> Qualité des données</Button>
            </Link>
            <Link href="/admin/refonte-donnees">
              <Button variant="outline"><DatabaseZap className="h-4 w-4" /> Refonte des données</Button>
            </Link>
            <Link href="/admin/marque">
              <Button variant="outline"><Palette className="h-4 w-4" /> Marque & modèles</Button>
            </Link>
            <Link href="/admin/settings">
              <Button variant="outline"><Settings2 className="h-4 w-4" /> Réglages & diffusion</Button>
            </Link>
            <Link href="/admin/regulatory-corpus">
              <Button variant="outline"><Library className="h-4 w-4" /> Corpus réglementaire</Button>
            </Link>
            <Link href="/admin/versions">
              <Button variant="outline"><Rocket className="h-4 w-4" /> Versions (test → prod)</Button>
            </Link>
            {/* LE JOURNAL DES DEMANDES D'ACHAT — la trace complète de ce que chacun demande aux
                moyens généraux, séparée de la file où on les traite. */}
            <Link href="/admin/achats">
              <Button variant="outline"><ScrollText className="h-4 w-4" /> Journal des demandes d&apos;achat</Button>
            </Link>
            <Link href="/admin/courrier">
              <Button variant="outline"><Mail className="h-4 w-4" /> Courrier (envoi sans SMTP)</Button>
            </Link>
            <Link href="/admin/workflows">
              <Button variant="outline"><Workflow className="h-4 w-4" /> Circuits de validation</Button>
            </Link>
            <Link href="/admin/adoption">
              <Button variant="outline"><Gauge className="h-4 w-4" /> Adoption</Button>
            </Link>
            {/* CARTE DE LA PLATEFORME : modules, gestes, circuits et droits par rôle (lus dans PERMISSIONS) — Super Admin seul. */}
            <Link href="/admin/carte-plateforme">
              <Button variant="outline"><MapIcon className="h-4 w-4" /> Carte de la plateforme</Button>
            </Link>
            {/* INTELLIGENCE TERRAIN (Direction, 10/2026) : graphe d'influence (Luna) et ROI Ad & Pro — Super Admin seul. */}
            <Link href="/admin/intelligence-terrain">
              <Button variant="outline"><Radar className="h-4 w-4" /> Intelligence terrain</Button>
            </Link>
            <Link href="/admin/ai">
              <Button variant="outline"><Bot className="h-4 w-4" /> Contrôle IA</Button>
            </Link>
            <Link href="/admin/regulatory-ia">
              <Button variant="outline"><Coins className="h-4 w-4" /> Coût IA & audit Regulatory</Button>
            </Link>
            <Link href="/admin/validations">
              <Button variant="outline"><ShieldCheck className="h-4 w-4" /> Validations</Button>
            </Link>
            <Link href="/admin/feedback">
              <Button variant="outline"><MessageSquare className="h-4 w-4" /> Feedbacks</Button>
            </Link>
            <Link href="/admin/suppliers">
              <Button variant="outline"><Factory className="h-4 w-4" /> Fournisseurs</Button>
            </Link>
            <Link href="/admin/entites">
              <Button variant="outline"><Building2 className="h-4 w-4" /> Entités</Button>
            </Link>
            {/* L'arbre entité → gammes → produits : c'est de LUI que découle ce que chacun voit. */}
            <Link href="/admin/gammes">
              <Button variant="outline"><Layers className="h-4 w-4" /> Gammes & produits</Button>
            </Link>
            <Link href="/organigramme">
              <Button variant="outline"><Network className="h-4 w-4" /> Organigramme</Button>
            </Link>
            <Link href="/rh/departements">
              <Button variant="outline"><Building2 className="h-4 w-4" /> Départements (RH)</Button>
            </Link>
            {/* Supprimer un groupe, un canal ou une notification reçue : la messagerie se lit
                par APPARTENANCE, donc ce qu'on n'a pas rejoint ne s'atteint que d'ici. */}
            <Link href="/admin/messagerie">
              <Button variant="outline"><MessagesSquare className="h-4 w-4" /> Messagerie &amp; notifications</Button>
            </Link>
            {/* La liaison au site public : la clé, la vérification, la mise en service (§118.160). */}
            <Link href="/admin/site-web">
              <Button variant="outline"><Globe2 className="h-4 w-4" /> Site web (connexion)</Button>
            </Link>
            <Link href="/admin/corbeille">
              <Button variant="outline"><Trash2 className="h-4 w-4" /> Corbeille</Button>
            </Link>
            <Link href="/admin/bases">
              <Button variant="outline"><Database className="h-4 w-4" /> Bases de données</Button>
            </Link>
          </>
        )}
        {canManage && (
          <Link href="/admin/fields">
            <Button variant="outline"><Columns3 className="h-4 w-4" /> Champs personnalisés</Button>
          </Link>
        )}
        {canManage && (
          <CreateRecordButton
            label="Nouvel utilisateur"
            title="Créer un utilisateur"
            description="Le compte devra changer son mot de passe à la première connexion."
            action={createUser}
            width="md"
            redirectBase="/admin/users"
            fields={[
              { type: "text", name: "name", label: "Nom complet", required: true, full: true },
              { type: "text", name: "email", label: "Email", required: true, inputMode: "email", autoComplete: "off" },
              { type: "text", name: "password", label: "Mot de passe temporaire (min. 8)", required: true },
              { type: "select", name: "role", label: "Rôle par défaut", options: optionsFromMap(ROLE_LABELS), required: true },
              { type: "text", name: "title", label: "Fonction" },
              { type: "text", name: "region", label: "Région" },
            ]}
          />
        )}
      </PageHeader>
      <ModuleTabs tabs={ADMIN_TABS.map((t) => ({ label: t.label, href: t.href, show: userCan(admin, t.module, "VIEW") }))} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Utilisateurs" value={users.length} icon="Users" />
        <KpiCard label="Actifs" value={active} icon="UserCheck" tone="success" />
        <KpiCard label="Sessions actives" value={activeSessions} icon="MonitorSmartphone" tone="info" />
        <KpiCard label="Événements d’activité" value={activityCount} icon="Activity" />
      </div>

      {/* STOCKAGE OBJET — sa propre carte, en tête, et non plus une ligne au bas d'une autre.
          C'est l'écran qu'on vient chercher quand un envoi échoue ou traîne : l'enterrer sous un
          tableau de comptes revenait à ne pas l'avoir. */}
      {admin.role === "SUPER_ADMIN" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><HardDrive className="h-4 w-4" /> Stockage objet (Supabase / S3)</CardTitle>
            <CardDescription>
              Où vivent réellement les octets. « Les variables sont renseignées » ne prouve rien : un bucket mal
              nommé, une clé périmée ou un chemin d&apos;endpoint incomplet donnent exactement la même page verte.
              Le test écrit un objet, le relit, compare son contenu et le supprime.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StoragePanel initial={describeConfig(process.env as Record<string, string | undefined>)} />
          </CardContent>
        </Card>
      )}

      {/* ÉDITEUR OFFICE — même place, même geste que le stockage : quand l'éditeur ne s'ouvre pas,
          c'est ici que le lien « Diagnostiquer » de l'écran d'édition mène (#editeur-office). */}
      {admin.role === "SUPER_ADMIN" && (
        <Card id="editeur-office" className="scroll-mt-20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><FileCog className="h-4 w-4" /> Éditeur Office (OnlyOffice)</CardTitle>
          </CardHeader>
          <CardContent>
            <OnlyofficePanel configure={onlyofficeConfigured()} adresse={onlyofficeServerUrl() || null} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Comptes & accès</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Utilisateur</TableHead>
                <TableHead>Rôle</TableHead>
                <TableHead>Accès personnalisés</TableHead>
                <TableHead>Dernière activité (dernier clic)</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell data-sans-etiquette className="">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Avatar name={u.name} color={u.avatarColor} size="sm" />
                      <div className="min-w-0 text-left"><p className="font-medium">{u.name}</p><p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{u.email}</p></div>
                    </div>
                  </TableCell>
                  <TableCell><Badge tone="neutral" dot={false}>{ROLE_LABELS[u.role] ?? u.role}</Badge></TableCell>
                  <TableCell>{u._count.access > 0 ? <Badge tone="info" dot={false}>{u._count.access} règle·s</Badge> : <span className="text-xs text-muted-foreground">Rôle par défaut</span>}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {(() => { const d = lastActivityOf(u); return d ? fmtWhen(d) : "Jamais"; })()}
                  </TableCell>
                  <TableCell>{u.isActive ? <Badge tone="success" dot={false}>Actif</Badge> : <Badge tone="danger" dot={false}>Inactif</Badge>}</TableCell>
                  <TableCell className="text-right">
                    {canManage ? (
                      <Link href={`/admin/users/${u.id}`} className="inline-flex min-h-9 items-center text-sm font-medium text-primary hover:underline sm:min-h-0">Gérer</Link>
                    ) : <span className="text-xs text-muted-foreground">—</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Stockage Drive : capacité modifiable + consommation exacte, globale et par utilisateur. */}
      {admin.role === "SUPER_ADMIN" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><HardDrive className="h-4 w-4" /> Stockage Drive</CardTitle>
            <CardDescription>
              Consommation exacte mesurée en base : le stockage <strong>physique</strong> est dédupliqué et chiffré
              (deux fichiers identiques ne comptent qu'une fois) ; le <strong>logique</strong> compte toutes les
              versions de tous les fichiers. La capacité et le quota par utilisateur sont appliqués à l'envoi.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-border p-3">
                <p className="text-xs text-muted-foreground">Physique (dédupliqué) / capacité</p>
                <p className="text-lg font-semibold">{fmtBytes(physicalBytes)} <span className="text-sm font-normal text-muted-foreground">/ {settings.driveCapacityGb} Go</span></p>
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-secondary">
                  <div className={`h-full ${physicalBytes / capacityBytes > 0.9 ? "bg-destructive" : "bg-primary"}`} style={{ width: `${Math.min(100, (physicalBytes / capacityBytes) * 100)}%` }} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{((physicalBytes / capacityBytes) * 100).toFixed(1)} % utilisé · {blobAgg._count} blob·s uniques</p>
              </div>
              <div className="rounded-xl border border-border p-3">
                <p className="text-xs text-muted-foreground">Logique (toutes versions)</p>
                <p className="text-lg font-semibold">{fmtBytes(logicalBytes)}</p>
                <p className="mt-1 text-xs text-muted-foreground">Économie de déduplication : {fmtBytes(Math.max(0, logicalBytes - physicalBytes))}</p>
              </div>
              <div className="rounded-xl border border-border p-3">
                <p className="mb-1 text-xs text-muted-foreground">Réglages (Super Admin)</p>
                <DriveStorageSettings capacityGb={settings.driveCapacityGb} userQuotaGb={settings.driveUserQuotaGb} />
              </div>
            </div>


            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Utilisateur</TableHead>
                    <TableHead className="text-right">Fichiers</TableHead>
                    <TableHead className="text-right">Consommation exacte</TableHead>
                    <TableHead className="w-56">Quota ({settings.driveUserQuotaGb} Go)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users
                    .map((u) => ({ u, usage: usageByOwner.get(u.id) ?? { bytes: 0, files: 0 } }))
                    .sort((a, b) => b.usage.bytes - a.usage.bytes)
                    .map(({ u, usage }) => {
                      const pct = Math.min(100, (usage.bytes / quotaBytes) * 100);
                      return (
                        <TableRow key={u.id}>
                          <TableCell data-sans-etiquette className="font-medium">{u.name}</TableCell>
                          <TableCell className="text-right text-muted-foreground">{usage.files}</TableCell>
                          <TableCell className="text-right font-medium">{fmtBytes(usage.bytes)}</TableCell>
                          <TableCell>
                            <div className="flex w-40 items-center gap-2 sm:w-auto">
                              <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                                <div className={`h-full ${pct > 90 ? "bg-destructive" : pct > 70 ? "bg-amber-500" : "bg-primary"}`} style={{ width: `${pct}%` }} />
                              </div>
                              <span className="w-12 text-right text-xs text-muted-foreground">{pct.toFixed(0)} %</span>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tableau clair : rôle principal + « autre rôle » (fonction secondaire), réglable par le Super Admin. */}
      <Card>
        <CardHeader>
          <CardTitle>Rôles principaux & secondaires</CardTitle>
          <CardDescription>
            Chaque compte a un <strong>rôle principal</strong> et, en option, un <strong>autre rôle</strong> (fonction
            secondaire : Direction, Direction Marketing, National Sales…). Le rôle secondaire <strong>cumule</strong>
            ses capacités à celles du rôle principal. Modifiable ici par le Super Admin.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <RolesTable
            users={users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, secondaryRole: u.secondaryRole ?? null }))}
            canManage={userCan(admin, "ADMIN", "UPDATE")}
          />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Settings2 className="h-4 w-4" /> Paramètres</CardTitle>
            <CardDescription>Configuration de l’instance.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2.5 text-sm">
            {[["Société", "Adventum Pharma"], ["Devise", "DZD"], ["Création de comptes", "Admin uniquement"],
              ["Mot de passe", "Changement forcé 1ʳᵉ connexion"], ["Politique d’accès", "RBAC + overrides + lignes"],
              ["Sessions", "Révocables"], ["Connexion", "Verrouillage anti-bruteforce"], ["IA", "Pilotée (Contrôle IA)"]].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3 border-b border-border pb-2 last:border-0">
                <span className="text-muted-foreground">{k}</span><span className="text-right font-medium">{v}</span>
              </div>
            ))}
          </CardContent>
        </Card>
        <div className="space-y-3 lg:col-span-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Journal d’audit ({auditCount})</h2>
          <AuditPanel count={auditCount} />
        </div>
      </div>
    </div>
  );
}
