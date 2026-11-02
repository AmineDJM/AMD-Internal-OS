import { redirect } from "next/navigation";

/**
 * L'ANCIENNE ADRESSE du montage des BU (« Force de vente › ⋯ › Réglages › Business units / Secteurs »). Le montage est
 * devenu le module « Business Units » (Direction, 08/10) : un lien gardé dans une notification, un favori ou un message
 * y mène toujours — `?etape=secteurs` vers l'onglet Secteurs, les autres étapes et `?bu=` suivent.
 */
export default async function AncienMontageBu(props: { searchParams?: Promise<{ etape?: string; bu?: string }> }) {
 const searchParams = await props.searchParams;
 const q = new URLSearchParams();
 if (searchParams?.bu) q.set("bu", searchParams.bu);
 const secteurs = searchParams?.etape === "secteurs";
 if (searchParams?.etape && !secteurs) q.set("etape", searchParams.etape);
 const s = q.toString();
 const chemin = secteurs ? "/business-units/secteurs" : "/business-units";
 redirect(s ? `${chemin}?${s}` : chemin);
}
