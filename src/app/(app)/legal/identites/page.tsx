import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { getMyCompanies, companyLabel } from "@/lib/company";
import { IDENTITY_SECTIONS, identityFieldKeys } from "@/lib/legal/identity";
import { IdentityBoard, type IdentityCompany } from "./identity-board";
import { lireSensiblesPour } from "@/modules/coffre/api-lecture";
import type { DocItem } from "@/components/documents/document-list";

export const dynamic = "force-dynamic";

/**
 * COORDONNÉES LÉGALES & FISCALES — la carte d'identité de chaque entité, copiable.
 *
 * RC, NIF, NIS, article d'imposition, RIB, siège : on les redemande dix fois par mois, sur un
 * appel d'offres, une facture, un contrat, un dossier bancaire. Recopiés de mémoire d'un vieux
 * document Word, ils arrivent avec une faute de frappe une fois sur cinq — et sur un numéro à
 * quinze chiffres, personne ne la voit avant le rejet du dossier.
 *
 * Leur place est ici, dans LEGAL : c'est le module des engagements de la société, et ces
 * numéros sont ce par quoi elle s'engage. On choisit l'entité, on lit, on copie — le champ
 * seul ou le bloc entier.
 */
export default async function LegalIdentitiesPage(props: { searchParams?: Promise<{ entite?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("LEGAL");
  const canEdit = userCan(user, "LEGAL", "UPDATE");

  // Le cloisonnement s'applique : on ne lit pas la carte fiscale d'une société qu'on ne voit pas.
  const mine = await getMyCompanies(user.id);
  if (mine.length === 0) {
    return (
      <div className="space-y-5">
        <PageHeader title="Coordonnées légales & fiscales" />
        <EmptyState
          icon="Building2"
          title="Aucune entité dans votre périmètre"
          description="Ces coordonnées appartiennent à une société : sans entité, il n'y a rien à afficher."
        />
      </div>
    );
  }

  // Les coordonnées ET les pièces des entités du périmètre, en deux requêtes — pas une par
  // société. Les pièces manquaient à l'écran : on pouvait en déposer, on ne les revoyait jamais.
  const [identities, docs] = await Promise.all([
    prisma.companyLegalIdentity.findMany({ where: { companyId: { in: mine.map((c) => c.id) } } }),
    prisma.document.findMany({
      where: { entityType: "COMPANY", entityId: { in: mine.map((c) => c.id) } },
      include: { uploadedBy: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const byCompany = new Map(identities.map((i) => [i.companyId, i]));
  // LE COFFRE (refonte V2-E) : RIB et IBAN des sociétés lus par la politique (les Finances), journalisés ; les
  // autres voient le masque — qui, renvoyé tel quel, garde la valeur en place, et qu'une saisie remplace.
  const bancaires = await lireSensiblesPour(user, {
    modele: "CompanyLegalIdentity", champs: ["rib", "iban"], geste: "Identités légales — consultation",
    lignes: identities.map((i) => ({ id: i.id, clair: i })),
  });

  const docsByCompany = new Map<string, DocItem[]>();
  for (const d of docs) {
    const item: DocItem = {
      id: d.id, name: d.name, category: d.category, version: d.version,
      sizeBytes: d.sizeBytes, confidentiality: d.confidentiality,
      uploadedBy: d.uploadedBy?.name ?? null,
      createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey),
    };
    docsByCompany.set(d.entityId, [...(docsByCompany.get(d.entityId) ?? []), item]);
  }

  const companies: IdentityCompany[] = mine.map((c) => {
    const row = byCompany.get(c.id) as Record<string, unknown> | undefined;
    const values: Record<string, string> = {};
    for (const key of identityFieldKeys()) {
      const v = row?.[key];
      values[key] = typeof v === "string" ? v : "";
    }
    const lus = row ? bancaires.get(String(row.id)) : undefined;
    for (const [champ, lu] of Object.entries(lus ?? {})) values[champ] = (lu.lu ? lu.valeur : lu.masque) ?? "";
    return { id: c.id, label: companyLabel(c), color: c.color, values, documents: docsByCompany.get(c.id) ?? [] };
  });

  const initial = searchParams?.entite && companies.some((c) => c.id === searchParams.entite)
    ? searchParams.entite
    : companies[0].id;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Coordonnées légales & fiscales"
        description="La carte d'identité de chaque entité — dénomination exacte, RC, NIF, NIS, article d'imposition, siège, banque, représentant légal. Choisissez l'entité, copiez le champ dont vous avez besoin ou le bloc entier : c'est ce qu'on recopie de mémoire, et c'est là que les fautes de frappe entrent dans les dossiers."
      />
      <IdentityBoard companies={companies} sections={IDENTITY_SECTIONS} initial={initial} canEdit={canEdit} />
    </div>
  );
}
