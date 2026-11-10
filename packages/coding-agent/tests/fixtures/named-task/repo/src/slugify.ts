export function slugify(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, "-");
}
