import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { ROLE_LABELS, MODULE_LABELS } from "@/lib/labels";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import {
  CATALOGUE_BASES, baseDe, enVigueur, historiqueBase, nomsDe, personnesActives, propresDonnees, quiVoitLaBase, reglagesVivants,
} from "@/modules/acces-bases/api";
import { ConsoleBases, type DetailBaseConsole } from "@/modules/acces-bases/ecrans/console-bases";

export const dynamic = "force-dynamic";

/**
 * ACCÈS PAR BASE (lot D2, décision 0057) — un niveau au-dessus des modules : Normal, Lecture seule, Fermée, Ouverte, par
 * rôle ou par personne, daté et motivé. Cette page RÈGLE et MONTRE ; l'application aux données vient avec la garde
 * centrale (D3 en observation, D4 strict sur décision de la Direction).
 */
export default async function AccesParBasePage({ searchParams }: { searchParams: Promise<{ base?: string }> }) {
  const admin = await requireModule("ADMIN", "UPDATE");
  if (admin.role !== "SUPER_ADMIN") redirect("/admin");
  const { base: choisie } = await searchParams;
  const maintenant = new Date();
  const [reglages, propres, personnes] = await Promise.all([reglagesVivants(), propresDonnees(), personnesActives()]);

  const bases = CATALOGUE_BASES.map((b) => ({
    cle: b.cle, nom: b.nom, nature: b.nature, sensibilite: b.sensibilite, tables: b.tables.length,
    reglages: reglages.filter((r) => r.base === b.cle && enVigueur(r, maintenant)).length, propresDonnees: propres[b.cle] ?? false,
  }));

  let detail: DetailBaseConsole | null = null;
  const b = choisie ? baseDe(choisie) : null;
  if (b) {
    const [historique, quiVoit] = await Promise.all([historiqueBase(b.cle), quiVoitLaBase(b.cle, maintenant)]);
    const noms = await nomsDe(historique.flatMap((r) => (r.userId ? [r.userId] : [])));
    const jour = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
    detail = {
      cle: b.cle, nom: b.nom, tables: [...b.tables], modules: b.modules.map((m) => MODULE_LABELS[m as keyof typeof MODULE_LABELS] ?? m),
      propresDonnees: propres[b.cle] ?? false,
      reglages: historique.map((r) => ({
        id: r.id, cible: r.userId ? (noms.get(r.userId) ?? "personne") : `Rôle ${ROLE_LABELS[r.role ?? ""] ?? r.role}`,
        niveau: r.niveau, ecriture: r.ecriture, du: jour(r.du)!, au: jour(r.au), motif: r.motif,
        revoque: !!r.revoqueLe, enVigueur: enVigueur(r, maintenant),
      })),
      quiVoit: (quiVoit ?? []).map((l) => ({ ...l, role: ROLE_LABELS[l.role] ?? l.role })),
    };
  }

  return (
    <div className="space-y-5">
      <BackLink href="/admin/access">
        <ArrowLeft className="h-4 w-4" /> Accès par module
      </BackLink>
      <PageHeader
        title="Accès par base"
        description="Ouvrir, fermer ou mettre en lecture seule une base entière (une famille de tables), pour un rôle ou une personne — en plus des accès par module. Chaque réglage est daté, motivé, journalisé et se défait en un geste. Phase actuelle : réglage et lecture ; l'application aux données est mesurée avant d'être activée."
      />
      <ConsoleBases
        bases={bases}
        detail={detail}
        personnes={personnes.map((p) => ({ id: p.id, nom: p.name }))}
        roles={Object.entries(ROLE_LABELS).map(([cle, libelle]) => ({ cle, libelle }))}
      />
    </div>
  );
}
