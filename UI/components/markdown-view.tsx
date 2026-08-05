import { Box, Typography } from '@mui/material'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { alpha, COLORS } from '../data/constants'

/** 行内代码样式；块级代码（pre > code）由 pre 后代选择器覆盖为透明背景 */
const CODE: Components['code'] = ({ children }) => (
  <Box
    component="code"
    sx={{
      fontFamily: COLORS.mono,
      fontSize: 12,
      bgcolor: COLORS.bgHover,
      px: 0.5,
      py: 0.25,
      borderRadius: '4px',
      color: COLORS.text,
    }}
  >
    {children}
  </Box>
)

const MD_COMPONENTS: Components = {
  h1: ({ children }) => (
    <Typography sx={{ fontSize: 16, fontWeight: 700, mb: 1, mt: 2, color: COLORS.text }}>
      {children}
    </Typography>
  ),
  h2: ({ children }) => (
    <Typography sx={{ fontSize: 15, fontWeight: 600, mb: 1, mt: 2.5, color: COLORS.text }}>
      {children}
    </Typography>
  ),
  h3: ({ children }) => (
    <Typography sx={{ fontSize: 13.5, fontWeight: 600, mb: 1, mt: 2, color: COLORS.text }}>
      {children}
    </Typography>
  ),
  p: ({ children }) => (
    <Typography sx={{ fontSize: 13, lineHeight: 1.8, color: COLORS.text, mb: 1 }}>
      {children}
    </Typography>
  ),
  strong: ({ children }) => (
    <Box component="strong" sx={{ color: COLORS.text, fontWeight: 600 }}>
      {children}
    </Box>
  ),
  em: ({ children }) => <Box component="em" sx={{ color: COLORS.textSecondary }}>{children}</Box>,
  ul: ({ children }) => <Box component="ul" sx={{ pl: 2.5, mb: 1 }}>{children}</Box>,
  ol: ({ children }) => <Box component="ol" sx={{ pl: 2.5, mb: 1 }}>{children}</Box>,
  li: ({ children }) => (
    <Box
      component="li"
      sx={{ fontSize: 13, lineHeight: 1.8, color: COLORS.textSecondary, mb: 0.5 }}
    >
      {children}
    </Box>
  ),
  code: CODE,
  pre: ({ children }) => (
    <Box
      component="pre"
      sx={{
        bgcolor: COLORS.bgHover,
        p: 1.25,
        borderRadius: '8px',
        overflowX: 'auto',
        mb: 1.25,
        border: `1px solid ${COLORS.border}`,
        '& code': { bgcolor: 'transparent', px: 0, py: 0, borderRadius: 0 },
      }}
    >
      {children}
    </Box>
  ),
  table: ({ children }) => (
    <Box
      component="table"
      sx={{
        borderCollapse: 'collapse',
        width: '100%',
        mb: 1.25,
        fontSize: 12.5,
      }}
    >
      {children}
    </Box>
  ),
  th: ({ children }) => (
    <Box
      component="th"
      sx={{
        border: `1px solid ${COLORS.border}`,
        px: 1,
        py: 0.5,
        fontWeight: 600,
        bgcolor: COLORS.bgHover,
        textAlign: 'left',
        color: COLORS.text,
      }}
    >
      {children}
    </Box>
  ),
  td: ({ children }) => (
    <Box
      component="td"
      sx={{ border: `1px solid ${COLORS.border}`, px: 1, py: 0.5, color: COLORS.textSecondary }}
    >
      {children}
    </Box>
  ),
  blockquote: ({ children }) => (
    <Box
      component="blockquote"
      sx={{
        borderLeft: `3px solid ${alpha(COLORS.accent, 0.4)}`,
        pl: 1.25,
        my: 1,
        color: COLORS.textSecondary,
      }}
    >
      {children}
    </Box>
  ),
  a: ({ href, children }) => (
    <Box
      component="a"
      href={href}
      target="_blank"
      rel="noreferrer"
      sx={{ color: COLORS.accent, textDecoration: 'underline' }}
    >
      {children}
    </Box>
  ),
  hr: () => (
    <Box component="hr" sx={{ border: 'none', borderTop: `1px solid ${COLORS.border}`, my: 1.5 }} />
  ),
}

/** Agent 回复 Markdown 渲染（MUI 映射，浅色瑞士风；与尽调正文同一套 token 风格） */
export function MarkdownView({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
      {content}
    </ReactMarkdown>
  )
}
