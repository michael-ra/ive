---
title: Getting Started
---

# Getting Started

<script setup>
import { onMounted } from 'vue'
import { useRouter } from 'vitepress'
const router = useRouter ? useRouter() : null
onMounted(() => { if (router) router.go('/guide/introduction') })
</script>

→ [Introduction](./introduction) — What IVE is and how it works

→ [Installation](./installation) — Set up and run

→ [Quick Start](./quick-start) — Create your first session
