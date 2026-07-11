'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Save,
  ArrowLeft,
  Bold,
  Italic,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Link2,
  Code,
  Minus,
} from 'lucide-react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import LinkExtension from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { useWikiCategories, useWikiTags, type WikiArticle, type WikiCategory } from '@/hooks/useWiki';
import { cn } from '@/lib/utils';

interface WikiArticleEditorProps {
  article?: WikiArticle;
  onSubmit: (data: {
    title: string;
    content: unknown;
    categoryId: string;
    type: 'article' | 'case_study';
    status: 'draft' | 'published';
    caseProblem?: string;
    caseSolution?: string;
    tagIds?: string[];
  }) => void;
  isSubmitting?: boolean;
}

/**
 * Flatten categories tree into a list with depth info for indented rendering.
 */
function flattenCategories(
  categories: WikiCategory[],
  depth = 0,
): Array<WikiCategory & { depth: number }> {
  const result: Array<WikiCategory & { depth: number }> = [];
  for (const cat of categories) {
    result.push({ ...cat, depth });
    if (cat.children && cat.children.length > 0) {
      result.push(...flattenCategories(cat.children, depth + 1));
    }
  }
  return result;
}

/**
 * Extract TipTap-compatible initial content from article data.
 * Supports both legacy text format and TipTap JSON format.
 */
function getInitialEditorContent(article?: WikiArticle): string | Record<string, unknown> {
  if (!article?.content) return '';
  const content = article.content as Record<string, unknown>;
  // TipTap JSON format (has "type": "doc")
  if (content.type === 'doc') return content as Record<string, unknown>;
  // Legacy text format
  if (content.type === 'text' && typeof content.content === 'string') return content.content;
  if (typeof article.content === 'string') return article.content;
  return '';
}

export function WikiArticleEditor({
  article,
  onSubmit,
  isSubmitting = false,
}: WikiArticleEditorProps) {
  const router = useRouter();
  const { data: categoriesData } = useWikiCategories();
  const { data: tagsData } = useWikiTags();

  const categories = categoriesData?.categories ?? [];
  const tags = tagsData?.tags ?? [];

  const initialContent = getInitialEditorContent(article);

  const [title, setTitle] = useState(article?.title ?? '');
  const [categoryId, setCategoryId] = useState(article?.category?.id ?? '');
  const [type, setType] = useState<'article' | 'case_study'>(article?.type ?? 'article');
  const [caseProblem, setCaseProblem] = useState(article?.caseProblem ?? '');
  const [caseSolution, setCaseSolution] = useState(article?.caseSolution ?? '');
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(
    article?.tags?.map((t) => t.id) ?? [],
  );
  const [showCategoryError, setShowCategoryError] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit,
      LinkExtension.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder: 'Article content...' }),
    ],
    content: initialContent || '',
    editorProps: {
      attributes: {
        class: 'prose prose-sm max-w-none min-h-[300px] px-4 py-3 outline-none',
      },
    },
  });

  const handleToggleTag = useCallback((tagId: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId],
    );
  }, []);

  const handleSubmit = useCallback(
    (status: 'draft' | 'published') => {
      if (!categoryId) {
        setShowCategoryError(true);
        return;
      }
      setShowCategoryError(false);
      const editorContent = editor?.getJSON() ?? { type: 'doc', content: [] };
      onSubmit({
        title,
        content: editorContent,
        categoryId,
        type,
        status,
        ...(type === 'case_study' ? { caseProblem, caseSolution } : {}),
        tagIds: selectedTagIds.length > 0 ? selectedTagIds : undefined,
      });
    },
    [title, editor, categoryId, type, caseProblem, caseSolution, selectedTagIds, onSubmit],
  );

  const flatCategories = flattenCategories(categories);
  const isEditing = !!article;

  return (
    <div className="min-h-screen bg-white">
      {/* Top bar */}
      <div className="sticky top-0 z-10 border-b border-[#e2e8f0] bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => router.back()}
              className="flex items-center gap-1.5 text-sm text-slate-500 transition-colors hover:text-slate-800"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
            <span className="text-slate-300">/</span>
            <h1 className="text-sm font-semibold text-slate-800">
              {isEditing ? 'Editing' : 'New article'}
            </h1>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => handleSubmit('draft')}
              className={cn(
                'rounded-lg border border-[#e2e8f0] bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors',
                'hover:bg-slate-50 disabled:opacity-50',
              )}
            >
              Save as draft
            </button>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => handleSubmit('published')}
              className={cn(
                'flex items-center gap-2 rounded-lg bg-[#6366f1] px-4 py-2 text-sm font-medium text-white transition-colors',
                'hover:bg-[#5558e6] disabled:opacity-50',
              )}
            >
              <Save className="h-4 w-4" />
              Publish
            </button>
          </div>
        </div>
      </div>

      {/* Form */}
      <div className="mx-auto max-w-[720px] px-6 py-8">
        {/* Title */}
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Article title"
          className="w-full border-0 border-b border-[#e2e8f0] pb-3 text-[22px] font-bold text-slate-900 placeholder:text-slate-300 focus:border-[#6366f1] focus:outline-none focus:ring-0"
        />

        {/* Meta row */}
        <div className="mt-6 flex flex-wrap items-center gap-4">
          {/* Category select */}
          <div>
            <select
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                if (e.target.value) setShowCategoryError(false);
              }}
              className={cn(
                'rounded-lg border-[1.5px] bg-white px-3 py-2 text-sm text-slate-700',
                'focus:border-[#6366f1] focus:outline-none focus:ring-2 focus:ring-[#6366f1]/20',
                showCategoryError ? 'border-red-400 ring-2 ring-red-100' : 'border-[#e2e8f0]',
              )}
            >
              <option value="">Select category</option>
              {flatCategories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {'\u00A0\u00A0'.repeat(cat.depth)}
                  {cat.name}
                </option>
              ))}
            </select>
            {showCategoryError && (
              <p className="mt-1 text-xs text-red-500">
                {flatCategories.length === 0
                  ? 'Create a category first in the Wiki sidebar'
                  : 'Please select a category'}
              </p>
            )}
          </div>

          {/* Type toggle */}
          <div className="flex overflow-hidden rounded-lg border border-[#e2e8f0]">
            <button
              type="button"
              onClick={() => setType('article')}
              className={cn(
                'px-4 py-2 text-sm font-medium transition-colors',
                type === 'article'
                  ? 'bg-[#6366f1] text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-50',
              )}
            >
              Article
            </button>
            <button
              type="button"
              onClick={() => setType('case_study')}
              className={cn(
                'px-4 py-2 text-sm font-medium transition-colors',
                type === 'case_study'
                  ? 'bg-[#6366f1] text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-50',
              )}
            >
              Case study
            </button>
          </div>
        </div>

        {/* Case fields */}
        {type === 'case_study' && (
          <div className="mt-6 space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">Problem</label>
              <textarea
                value={caseProblem}
                onChange={(e) => setCaseProblem(e.target.value)}
                placeholder="Describe the problem..."
                rows={3}
                className={cn(
                  'w-full rounded-lg border-[1.5px] border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-sm text-slate-800',
                  'placeholder:text-red-300 focus:border-[#6366f1] focus:outline-none focus:ring-2 focus:ring-[#6366f1]/20',
                )}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">Solution</label>
              <textarea
                value={caseSolution}
                onChange={(e) => setCaseSolution(e.target.value)}
                placeholder="Describe the solution..."
                rows={3}
                className={cn(
                  'w-full rounded-lg border-[1.5px] border-[#bbf7d0] bg-[#f0fdf4] px-3 py-2 text-sm text-slate-800',
                  'placeholder:text-green-300 focus:border-[#6366f1] focus:outline-none focus:ring-2 focus:ring-[#6366f1]/20',
                )}
              />
            </div>
          </div>
        )}

        {/* Content editor */}
        <div className="mt-6">
          {/* Toolbar */}
          <div className="flex items-center gap-1 rounded-t-lg border border-b-0 border-[#e2e8f0] bg-slate-50 px-2 py-1.5">
            <button
              type="button"
              onClick={() => editor?.chain().focus().toggleBold().run()}
              className={cn('rounded p-1.5 hover:bg-slate-200 hover:text-slate-600', editor?.isActive('bold') ? 'bg-slate-200 text-accent' : 'text-slate-400')}
              title="Bold"
            >
              <Bold className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => editor?.chain().focus().toggleItalic().run()}
              className={cn('rounded p-1.5 hover:bg-slate-200 hover:text-slate-600', editor?.isActive('italic') ? 'bg-slate-200 text-accent' : 'text-slate-400')}
              title="Italic"
            >
              <Italic className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
              className={cn('rounded p-1.5 hover:bg-slate-200 hover:text-slate-600', editor?.isActive('heading', { level: 2 }) ? 'bg-slate-200 text-accent' : 'text-slate-400')}
              title="Heading 2"
            >
              <Heading2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
              className={cn('rounded p-1.5 hover:bg-slate-200 hover:text-slate-600', editor?.isActive('heading', { level: 3 }) ? 'bg-slate-200 text-accent' : 'text-slate-400')}
              title="Heading 3"
            >
              <Heading3 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => editor?.chain().focus().toggleBulletList().run()}
              className={cn('rounded p-1.5 hover:bg-slate-200 hover:text-slate-600', editor?.isActive('bulletList') ? 'bg-slate-200 text-accent' : 'text-slate-400')}
              title="Bullet list"
            >
              <List className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => editor?.chain().focus().toggleOrderedList().run()}
              className={cn('rounded p-1.5 hover:bg-slate-200 hover:text-slate-600', editor?.isActive('orderedList') ? 'bg-slate-200 text-accent' : 'text-slate-400')}
              title="Ordered list"
            >
              <ListOrdered className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
              className={cn('rounded p-1.5 hover:bg-slate-200 hover:text-slate-600', editor?.isActive('codeBlock') ? 'bg-slate-200 text-accent' : 'text-slate-400')}
              title="Code block"
            >
              <Code className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => editor?.chain().focus().setHorizontalRule().run()}
              className="rounded p-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
              title="Divider"
            >
              <Minus className="h-4 w-4" />
            </button>
          </div>

          {/* TipTap editor */}
          <div className="rounded-b-lg border-[1.5px] border-[#e2e8f0] focus-within:border-[#6366f1] focus-within:ring-2 focus-within:ring-[#6366f1]/20">
            <EditorContent editor={editor} />
          </div>
        </div>

        {/* Tags */}
        <div className="mt-6">
          <label className="mb-2 block text-sm font-medium text-slate-700">Labels</label>
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => {
              const isSelected = selectedTagIds.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => handleToggleTag(tag.id)}
                  className={cn(
                    'rounded-full px-3 py-1 text-sm font-medium transition-colors',
                    isSelected
                      ? 'bg-[#6366f1] text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                  )}
                >
                  {tag.name}
                </button>
              );
            })}
            {tags.length === 0 && (
              <span className="text-sm text-slate-400">No available tags</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
