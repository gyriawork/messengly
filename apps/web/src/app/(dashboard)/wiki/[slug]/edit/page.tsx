'use client';

import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';

// The TipTap editor drags in the whole @tiptap bundle — load on demand.
const WikiArticleEditor = dynamic(
  () => import('@/components/wiki/WikiArticleEditor').then((m) => m.WikiArticleEditor),
  { ssr: false },
);
import { useWikiArticle, useUpdateWikiArticle, type UpdateArticleInput } from '@/hooks/useWiki';
import { RequireOrgContext } from '@/components/layout/RequireOrgContext';

export default function EditWikiArticlePage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;

  const { data: article, isLoading } = useWikiArticle(slug);
  const updateArticle = useUpdateWikiArticle();

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  if (!article) {
    return (
      <div className="flex h-full items-center justify-center text-slate-400">
        Article not found
      </div>
    );
  }

  return (
    <RequireOrgContext>
    <div className="h-full overflow-auto">
      <WikiArticleEditor
        article={article}
        onSubmit={(data: UpdateArticleInput & { title: string; content: unknown; categoryId: string; type: 'article' | 'case_study'; status: 'draft' | 'published' }) => {
          updateArticle.mutate(
            { id: article.id, ...data },
            {
              onSuccess: () => {
                router.push(`/wiki/${article.slug}`);
              },
            },
          );
        }}
        isSubmitting={updateArticle.isPending}
      />
    </div>
    </RequireOrgContext>
  );
}
