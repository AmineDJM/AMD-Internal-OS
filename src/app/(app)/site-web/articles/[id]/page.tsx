import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import { formatDateTime } from "@/lib/utils";
import { etatAffiche, publicationsDe, slugsDuDepotConnus, suspensionEnVigueur } from "@/lib/site-web/etat";
import { peutEcrireArticles, peutSupprimerArticles } from "@/lib/site-web/acces";
import { ArticleForm } from "@/components/site-web/article-form";
import { disponibiliteRedaction } from "@/lib/redaction-site-ia";
import { RepriseNote } from "@/components/site-web/reprise";

export const dynamic = "force-dynamic";
export const metadata = { title: "Article — AMD Internal OS" };

/** La date d'un champ `date` HTML, au jour d'Alger — sans quoi une date posée à 23 h la veille glisserait d'un jour. */
function jourDAlger(d: Date | null): string {
  if (!d) return "";
  return new Intl.DateTimeFormat("fr-CA", { timeZone: "Africa/Algiers", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** UN ARTICLE — son texte, ses contrôles, et son état SUR LE SITE (confirmé par le site, jamais supposé). */
export default async function ArticlePage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireModule("SITE_WEB");
  const a = await prisma.blogArticle.findUnique({
    where: { id: params.id },
    include: {
      createdBy: { select: { name: true } }, updatedBy: { select: { name: true } },
      reprise: { select: { origine: true, cleSite: true, titre: true, createdAt: true } },
    },
  });
  if (!a) notFound();
  const [pubs, suspendu, depot, categories, ia] = await Promise.all([
    publicationsDe("POST", [a.id]),
    suspensionEnVigueur(),
    slugsDuDepotConnus(),
    prisma.blogArticle.findMany({ where: { category: { not: null } }, distinct: ["category"], select: { category: true }, take: 50 }),
    disponibiliteRedaction(),
  ]);
  const pub = pubs.get(a.id) ?? null;
  const etat = etatAffiche(pub, a.published, suspendu);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <BackLink href="/site-web/articles"><ArrowLeft className="h-4 w-4" /> Articles</BackLink>
      <PageHeader
        title={a.title}
        description={`Créé${a.createdBy ? ` par ${a.createdBy.name}` : ""} le ${formatDateTime(a.createdAt)} · modifié${a.updatedBy ? ` par ${a.updatedBy.name}` : ""} le ${formatDateTime(a.updatedAt)}${a.revisedAt ? ` · dernière révision publiée le ${formatDateTime(a.revisedAt)}` : ""}`}
      />
      <RepriseNote reprise={a.reprise} dejaEnvoye={pub !== null} />
      <ArticleForm
        article={{
          id: a.id, title: a.title, slug: a.slug ?? "", description: a.description ?? "", body: a.body, category: a.category ?? "",
          tags: a.tags.join(", "), author: a.author ?? "", publishedOn: jourDAlger(a.publishedOn), featured: a.featured, published: a.published,
        }}
        dejaEnvoye={pub !== null}
        etat={{ libelle: etat.libelle, ton: etat.ton, detail: etat.detail, lien: etat.lien }}
        slugsDuDepot={depot.slugs}
        depotConnuAu={depot.au ? depot.au.toISOString() : null}
        peutEcrire={peutEcrireArticles(user)}
        peutSupprimer={peutSupprimerArticles(user)}
        categories={categories.flatMap((c) => (c.category ? [c.category] : []))}
        ia={ia}
      />
    </div>
  );
}
