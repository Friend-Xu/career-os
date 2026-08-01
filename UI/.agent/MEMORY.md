# Career OS — Agent Memory

## Design decisions
- **IDE + workbench shell** (not SaaS dashboard): 60px top bar, 80px icon nav, 200px secondary, collapsible 350px AI panel, 32px status bar
- **Theme**: dark default (`#0D0F14`); light/dark via `useColorScheme` + top-bar `ThemeToggle`
- **Surface tokens**: `--cos-*` in `index.css` (`:root`/`html.dark`/`html.light`); `COLORS` uses vars; never append hex alpha to CSS vars — use `alpha()`; `RISK_COLOR` stays solid hex
- **Action-first workbench**: Next Action is sole highlight; no large KPI cards
- **Page defaults**: workbench=narrow+agent open; agent/resumes=fullscreen agent hidden; infopool=fullscreen; applications=wide; settings=agent hidden
- **State**: zustand `store/app-store.ts`; mock data in `data/mock-data.ts`
- **MUI v9**: Stack has no `alignItems`/`justifyContent` props — put in `sx`; Dialog/Drawer use `slotProps.paper` not `PaperProps`
- **Shortcuts**: ⌘K palette, ⌘B agent panel, ⌘1-6 nav, ⌘N new session, ⌘, settings
- **Role accent**: current role color drives chips/highlights; primary accent `#8B7CFF`
