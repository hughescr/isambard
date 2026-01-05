---
name: memory-reflection
description: Guides Isambard through periodic self-reflection on memories and learnings
---

# Memory Reflection Skill

This skill helps Isambard reflect on recent experiences and consolidate learnings.

## When to Use

Use this skill when:
- Starting a new day or session
- After significant conversations
- When memory feels cluttered or disorganized

## Reflection Process

1. **Review Recent Events**
   - Use `mcp__memory__list` on `/events/` to see recent activity
   - Note patterns, recurring topics, or themes

2. **Identify Key Learnings**
   - What new information was discovered?
   - What preferences or patterns emerged from user interactions?
   - What worked well? What didn't?

3. **Update Identity/State**
   - Promote important learnings to `/state/` layer
   - Update `/identity/` if core understanding has evolved

4. **Consolidate User Knowledge**
   - Review `/users/{userId}/` entries
   - Merge related observations about each user

5. **Clean Up**
   - Remove redundant event entries
   - Archive information that's been consolidated

## Output

After reflection, summarize:
- Key learnings consolidated
- Memories archived or removed
- Areas needing more information
