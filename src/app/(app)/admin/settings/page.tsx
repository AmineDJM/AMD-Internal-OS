import { redirect } from "next/navigation";
import { ArrowLeft, SlidersHorizontal, Megaphone, MailWarning, FileCheck2, ScanSearch, ShieldCheck, MessageSquarePlus, FolderPlus, BarChart3, Network, Layers, LayoutGrid, Lock } from "lucide-react";
import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";
import { ROLE_LABELS } from "@/lib/labels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminLimitsForm, AdProDgThresholdForm, BroadcastComposer, MailDiagnosticPanel, RegEnrollmentToggle, RegIntelligenceToggles, RegulatorySupervisorForm, RegulatoryTherapeuticSegmentsForm, RegulatoryHiddenColumnsForm, DriveSpaceCreatorForm, FieldReportsOverviewForm, PromoMessageAuthorsForm, OrgChartViewersForm, HiddenModulesForm, PipelineAccessForm, DirectiveAccessForm } from "./admin-settings-forms";
import { SeparationTachesToggle } from "./separation-taches-toggle";
import { MODULES } from "@/lib/rbac";
import { MODULE_LABELS } from "@/lib/labels";
import { isHideable } from "@/lib/modules-visibility";
import { BackLink } from "@/components/shared/back-link";

export const metadata = { title: "Réglages & diffusion — AMD Internal OS" };
export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const admin = await requireModule("ADMIN", "UPDATE");
  if (admin.role !== "SUPER_ADMIN") redirect("/admin");

  const [settings, users, mailAccounts, companies, regFlags] = await Promise.all([
    getAppSettings(),
    prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true, role: true }, orderBy: { name: "asc" } }),
    prisma.mailAccount.findMany({ select: { userId: true, email: true, user: { select: { name: true } } }, orderBy: { email: "asc" } }),
    prisma.company.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.regulatoryFeatureAccess.findMany({ select: { companyId: true, enabled: true } }),
  ]);
  const roleOptions = Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }));
  const mailboxes = mailAccounts.map((a) => ({ userId: a.userId, email: a.email, name: a.user?.name ?? a.email }));
  const regEnabled = new Map(regFlags.map((f) => [f.companyId, f.enabled]));
  const regIntelligenceCompanies = companies.map((c) => ({ id: c.id, name: c.name, enabled: regEnabled.get(c.id) ?? false }));

  return (
    <div className="space-y-5">
      <BackLink href="/admin">
        <ArrowLeft className="h-4 w-4" /> Retour à l'administration
      </BackLink>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Réglages & diffusion</h1>
        <p className="text-sm text-muted-foreground">Espace Super Admin : limites de l'instance et notifications diffusées.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><SlidersHorizontal className="h-4 w-4" /> Limites de l'instance</CardTitle>
          <p className="text-sm text-muted-foreground">Taille maximale des fichiers téléversés, par espace. S'applique immédiatement.</p>
        </CardHeader>
        <CardContent>
          <AdminLimitsForm settings={settings} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><SlidersHorizontal className="h-4 w-4" /> Ad &amp; Pro — seuil de validation du Directeur Général</CardTitle>
          <p className="text-sm text-muted-foreground">Le montant à partir duquel le Directeur Général valide en plus, sur TOUTES les demandes Ad &amp; Pro, matériel promotionnel compris. S&apos;applique immédiatement, y compris aux demandes en cours.</p>
        </CardHeader>
        <CardContent>
          <AdProDgThresholdForm settings={settings} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Centre de paiement — séparation des tâches</CardTitle>
          <p className="text-sm text-muted-foreground">Celui qui demande un paiement ne l&apos;autorise pas lui-même ; celui qui l&apos;a demandé ou autorisé ne le règle pas. Active par défaut ; chaque changement est journalisé.</p>
        </CardHeader>
        <CardContent>
          <SeparationTachesToggle active={settings.separationTachesPaiement} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FileCheck2 className="h-4 w-4" /> Regulatory — Enregistrement (CTD)</CardTitle>
          <p className="text-sm text-muted-foreground">Débloque l'onglet « Enregistrement » dans Regulatory : référentiel réglementaire ANPP + analyseur de dossier CTD. Masqué par défaut.</p>
        </CardHeader>
        <CardContent>
          <RegEnrollmentToggle enabled={settings.regEnrollmentEnabled} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Regulatory — Superviseurs (priorités, dates, notifications)</CardTitle>
          <p className="text-sm text-muted-foreground">Rôles autorisés (en plus du Super Admin, toujours inclus) à fixer la priorité et les dates cibles des dossiers, à recevoir les notifications (nouveau dossier / dépôt) et à demander des mises à jour de statut.</p>
        </CardHeader>
        <CardContent>
          <RegulatorySupervisorForm roles={roleOptions} selected={settings.regulatorySupervisorRoles} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Layers className="h-4 w-4" /> Regulatory — Segments thérapeutiques</CardTitle>
          <p className="text-sm text-muted-foreground">Les segments proposés par le menu « Segments » du tableau Regulatory (un produit peut en servir plusieurs). Composez la liste adaptée à votre marché ; une liste vide rétablit la liste par défaut intégrée.</p>
        </CardHeader>
        <CardContent>
          <RegulatoryTherapeuticSegmentsForm segments={settings.regulatoryTherapeuticSegments} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Layers className="h-4 w-4" /> Regulatory — Colonnes du tableau</CardTitle>
          <p className="text-sm text-muted-foreground">Les colonnes retirées du tableau Regulatory, dans le <strong>Suivi de dossiers</strong> comme dans le <strong>Pipeline</strong>, pour tout le monde. À ne pas confondre avec le bouton « Colonnes » du tableau, qui reste : celui-là est une préférence de navigateur. <strong>Aucune donnée n&apos;est effacée</strong> — les valeurs restent sur les fiches et reviennent dès qu&apos;on remet la colonne. La <strong>référence</strong> ne se masque pas : elle identifie la ligne.</p>
        </CardHeader>
        <CardContent>
          <RegulatoryHiddenColumnsForm hidden={settings.regulatoryHiddenColumns} />
        </CardContent>
      </Card>

      {/* LES DIRECTIVES — qui les lit, qui les rédige. La PUBLICATION n'est pas ici : elle
          appartient à la direction générale, en dur. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Megaphone className="h-4 w-4" /> Directives — Accès au module</CardTitle>
          <p className="text-sm text-muted-foreground">Une <strong>note de service</strong> s&apos;adresse à une ou plusieurs personnes, à un rôle, à une entité, ou à <strong>tous les salariés</strong>. Ouvrez la <strong>lecture</strong> largement — chacun doit recevoir les notes qui le concernent —, et la <strong>rédaction</strong> à ceux qui préparent les consignes. La <strong>publication</strong>, elle, reste au Directeur Général : elle ne se règle pas.</p>
        </CardHeader>
        <CardContent>
          <DirectiveAccessForm roles={roleOptions} users={users} settings={settings} />
        </CardContent>
      </Card>

      {/* LE PIPELINE — le portefeuille qu'on étudie avant de décider de le déposer. Réglage à
          part, et deux niveaux distincts : lire n'est pas publier. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Lock className="h-4 w-4" /> Pipeline réglementaire — Accès aux dossiers verrouillés</CardTitle>
          <p className="text-sm text-muted-foreground">Un dossier <strong>verrouillé</strong> est un produit à l&apos;étude : invisible de toute la plateforme — tableau, recherche, sélecteurs de produits, assistant. Ouvrez la <strong>consultation</strong> à ceux qui montent le dossier, et le <strong>cadenas</strong> — qui publie un dossier à toute l&apos;entreprise — à beaucoup moins de monde. Le Super Admin garde les deux.</p>
        </CardHeader>
        <CardContent>
          <PipelineAccessForm roles={roleOptions} users={users} settings={settings} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><MessageSquarePlus className="h-4 w-4" /> Demandes à Regulatory — Émetteurs autorisés</CardTitle>
          <p className="text-sm text-muted-foreground">Rôles autorisés à créer des « Demandes à Regulatory » (en plus du PRIM et du Super Admin, toujours inclus). L&apos;équipe Regulatory répond aux demandes mais n&apos;en crée pas — sauf si vous ajoutez son rôle ici.</p>
        </CardHeader>
        <CardContent>
        </CardContent>
      </Card>

      {/* MODULES EN SERVICE — masquer n'est pas un droit, c'est un état : « ce module n'est pas
          en usage ici, pour personne ». Rien n'est supprimé, et démasquer rend tout tel quel. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><LayoutGrid className="h-4 w-4" /> Modules en service</CardTitle>
          <p className="text-sm text-muted-foreground">Retirez de la plateforme les modules qui ne sont pas en usage — pas encore déployés, en refonte, ou dont l&apos;entreprise ne se sert pas. Ce n&apos;est <strong>pas une permission</strong> : les droits ne bougent pas, les données restent, et démasquer rend le module tel qu&apos;il était.</p>
        </CardHeader>
        <CardContent>
          <HiddenModulesForm
            modules={MODULES.filter(isHideable).map((m) => ({ value: m, label: MODULE_LABELS[m] ?? m }))}
            selected={settings.hiddenModules}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FolderPlus className="h-4 w-4" /> Drive — Créateurs de catégories</CardTitle>
          <p className="text-sm text-muted-foreground">Rôles autorisés (en plus du Super Admin, toujours inclus) à créer des « catégories » de Drive : des espaces partagés (type « Promotion Médicale ») présentés en onglets à côté de Drive et Documents. Le créateur en gère les accès (qui consulte, qui dépose).</p>
        </CardHeader>
        <CardContent>
          <DriveSpaceCreatorForm roles={roleOptions} selected={settings.driveSpaceCreatorRoles} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><BarChart3 className="h-4 w-4" /> Rapports terrain — Accès à l'onglet « Overview »</CardTitle>
          <p className="text-sm text-muted-foreground">Rôles autorisés (en plus du Super Admin, toujours inclus) à voir l'onglet « Overview » des Rapports terrain : graphes d'analyse (visites par médecin, hôpital, délégué, spécialité, tendance sur 12 mois…).</p>
        </CardHeader>
        <CardContent>
          <FieldReportsOverviewForm roles={roleOptions} selected={settings.fieldReportsOverviewRoles} />
        </CardContent>
      </Card>

      {/* LES AUTEURS DES MESSAGES DE LA DIRECTION MARKETING. Ce n'est pas un confort : chaque
          rapport terrain EXIGE au moins un message pré-défini, donc tant que personne ne peut en
          publier, tous les rapports sont refusés (§118.50 — une capacité qu'aucun écran
          n'accorde n'existe pas). */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><BarChart3 className="h-4 w-4" /> Messages Direction Marketing — Qui peut les écrire</CardTitle>
          <p className="text-sm text-muted-foreground">Rôles autorisés (en plus du Super Admin) à publier les messages pré-définis que les KAM portent au médecin — ce que chaque rapport terrain exige de citer. Une LISTE DE RÔLES et non un droit de module : Direction Marketing n&apos;a que la lecture sur la promotion médicale, et lui donner l&apos;écriture du module ouvrirait aussi les praticiens et les visites.</p>
        </CardHeader>
        <CardContent>
          <PromoMessageAuthorsForm roles={roleOptions} selected={settings.promoMessageAuthorRoles} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Network className="h-4 w-4" /> Organigramme — Qui peut le consulter</CardTitle>
          <p className="text-sm text-muted-foreground">Rôles (les Ressources humaines au premier chef) et personnes nommées autorisés à consulter l&apos;organigramme sur <strong>/organigramme</strong> — par entité ou sur le groupe entier. Le Super Admin reste seul à réorganiser les rattachements, les postes et la carte.</p>
        </CardHeader>
        <CardContent>
          <OrgChartViewersForm roles={roleOptions} users={users} selectedRoles={settings.orgChartViewerRoles} selectedUserIds={settings.orgChartViewerUserIds} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ScanSearch className="h-4 w-4" /> Regulatory Intelligence — Analyse CTD (par entité)</CardTitle>
          <p className="text-sm text-muted-foreground">Débloque l'analyse intelligente des dossiers CTD (ingestion ZIP sécurisée, lecture, classement, contrôles réglementaires) pour chaque organisation. Verrouillé par défaut.</p>
        </CardHeader>
        <CardContent>
          <RegIntelligenceToggles companies={regIntelligenceCompanies} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Megaphone className="h-4 w-4" /> Diffuser une notification</CardTitle>
          <p className="text-sm text-muted-foreground">Envoyez une notification à tout le monde, à un rôle, ou à des personnes choisies. Elle apparaît dans leur cloche (et en push si activé).</p>
        </CardHeader>
        <CardContent>
          <BroadcastComposer roles={roleOptions} users={users} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><MailWarning className="h-4 w-4" /> Diagnostic e-mail</CardTitle>
          <p className="text-sm text-muted-foreground">Teste une connexion IMAP réelle pour une boîte connectée et affiche l'erreur <strong>brute</strong> du fournisseur + sa cause probable (limite de connexions, IP bloquée, identifiants…). Aucune action sur la boîte.</p>
        </CardHeader>
        <CardContent>
          <MailDiagnosticPanel mailboxes={mailboxes} />
        </CardContent>
      </Card>
    </div>
  );
}
