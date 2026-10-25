// Standard JSON Schema transcribed from Pi MEMORY_TOOL_SCHEMAS.
// DSH session ids are optional assertions of exec.agent.id, never routing input.
export const extraSchemas = {
  "mem_capture_passive": {
    "type": "object",
    "properties": {
      "content": {
        "type": "string",
        "description": "Text output containing a ## Key Learnings section"
      },
      "source": {
        "type": "string",
        "description": "Source identifier, e.g. subagent-stop or session-end"
      }
    },
    "required": [
      "content"
    ]
  },
  "mem_compare": {
    "type": "object",
    "properties": {
      "memory_id_a": {
        "type": "number",
        "description": "Integer id of the first observation"
      },
      "memory_id_b": {
        "type": "number",
        "description": "Integer id of the second observation"
      },
      "relation": {
        "type": "string",
        "description": "Verdict: related | compatible | scoped | conflicts_with | supersedes | not_conflict",
        "enum": [
          "related",
          "compatible",
          "scoped",
          "conflicts_with",
          "supersedes",
          "not_conflict"
        ]
      },
      "confidence": {
        "type": "number",
        "description": "Confidence score 0.0..1.0",
        "minimum": 0,
        "maximum": 1
      },
      "reasoning": {
        "type": "string",
        "description": "Brief explanation of the verdict"
      },
      "model": {
        "type": "string",
        "description": "Model identifier for provenance"
      }
    },
    "required": [
      "memory_id_a",
      "memory_id_b",
      "relation",
      "confidence",
      "reasoning"
    ]
  },
  "mem_consolidate": {
    "type": "object",
    "properties": {
      "ids_to_delete": {
        "type": "array",
        "items": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "minItems": 2,
        "uniqueItems": true,
        "description": "At least two distinct positive exact JSON observation IDs"
      },
      "new_title": {
        "type": "string",
        "minLength": 1,
        "description": "Non-empty consolidated survivor title"
      },
      "new_content": {
        "type": "string",
        "minLength": 1,
        "description": "Consolidated content; Go appends provenance"
      },
      "expected_project": {
        "type": "string",
        "minLength": 1,
        "description": "Explicit canonical owner of every source, not a project override"
      },
      "type": {
        "type": "string",
        "description": "Optional survivor type; defaults to newest source"
      },
      "topic_key": {
        "type": "string",
        "description": "Optional explicit survivor topic key"
      },
      "confirm": {
        "type": "boolean",
        "description": "Default false: preview without writes. Confirm only the inspected exact plan; never auto-confirm a replacement"
      },
      "fingerprint": {
        "type": "string",
        "description": "Opaque Go preview fingerprint; required with confirm=true. Never retry an uncertain confirmation"
      }
    },
    "required": [
      "ids_to_delete",
      "new_title",
      "new_content",
      "expected_project"
    ]
  },
  "mem_doctor": {
    "type": "object",
    "properties": {
      "check": {
        "type": "string",
        "description": "Optional diagnostic check code to run"
      },
      "project": {
        "type": "string",
        "description": "Project to diagnose; defaults to current project"
      }
    },
    "required": []
  },
  "mem_get_observation": {
    "type": "object",
    "properties": {
      "id": {
        "type": "number",
        "description": "Observation ID to retrieve. Read in full before deciding identity or updating."
      },
      "include_history": {
        "type": "boolean",
        "description": "Include Go-owned paginated history: at most 50 prior snapshots, oldest first within each page, with total version_count and continuation metadata when older pages remain"
      },
      "history_cursor": {
        "type": "number",
        "description": "Non-negative integer cursor returned as history_cursor by a previous history page; omit or use 0 for the most recent page. Go validates it only when include_history is true"
      }
    },
    "required": [
      "id"
    ]
  },
  "mem_judge": {
    "type": "object",
    "properties": {
      "judgment_id": {
        "type": "string",
        "description": "The relation judgment_id returned by mem_save candidates"
      },
      "relation": {
        "type": "string",
        "description": "Verdict: related | compatible | scoped | conflicts_with | supersedes | not_conflict",
        "enum": [
          "related",
          "compatible",
          "scoped",
          "conflicts_with",
          "supersedes",
          "not_conflict"
        ]
      },
      "reason": {
        "type": "string",
        "description": "Free-text explanation of the verdict"
      },
      "evidence": {
        "type": "string",
        "description": "Supporting evidence as JSON or text"
      },
      "confidence": {
        "type": "number",
        "description": "Confidence score 0.0..1.0",
        "minimum": 0,
        "maximum": 1
      },
      "session_id": {
        "type": "string",
        "description": "Session ID for provenance"
      }
    },
    "required": [
      "judgment_id",
      "relation"
    ]
  },
  "mem_judge_many": {
    "type": "object",
    "properties": {
      "judgments": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "judgment_id": {
              "type": "string",
              "description": "Pending relation judgment ID"
            },
            "relation": {
              "type": "string",
              "description": "related | compatible | scoped | conflicts_with | supersedes | not_conflict",
              "enum": [
                "related",
                "compatible",
                "scoped",
                "conflicts_with",
                "supersedes",
                "not_conflict"
              ]
            },
            "reason": {
              "type": "string",
              "description": "Explanation of the verdict"
            },
            "evidence": {
              "type": "string",
              "description": "Supporting evidence"
            },
            "confidence": {
              "type": "number",
              "minimum": 0,
              "maximum": 1,
              "description": "Confidence score 0.0..1.0"
            }
          },
          "required": [
            "judgment_id",
            "relation"
          ]
        },
        "minItems": 1,
        "maxItems": 32,
        "description": "Ordered judgments; item errors do not roll back other writes. Never replay an uncertain batch"
      },
      "session_id": {
        "type": "string",
        "description": "Optional shared provenance; replaces per-item provenance"
      }
    },
    "required": [
      "judgments"
    ]
  },
  "mem_list_projects": {
    "type": "object",
    "properties": {},
    "required": []
  },
  "mem_pin": {
    "type": "object",
    "properties": {
      "id": {
        "type": "number",
        "description": "Observation ID to pin"
      }
    },
    "required": [
      "id"
    ]
  },
  "mem_review": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "description": "Action: list | mark_reviewed",
        "enum": [
          "list",
          "mark_reviewed"
        ]
      },
      "project": {
        "type": "string",
        "description": "Optional project selector; defaults to the current project"
      },
      "limit": {
        "type": "number",
        "description": "Max results for action=list"
      },
      "observation_id": {
        "type": "number",
        "description": "Observation id for action=mark_reviewed"
      },
      "id": {
        "type": "number",
        "description": "Alias for observation_id"
      },
      "all_projects": {
        "type": "boolean",
        "description": "Explicit all-project review listing; valid only with action=list"
      }
    },
    "required": [
      "action"
    ]
  },
  "mem_save_prompt": {
    "type": "object",
    "properties": {
      "content": {
        "type": "string",
        "description": "The user's prompt text"
      },
      "project": {
        "type": "string",
        "description": "Optional project"
      },
      "cwd": {
        "type": "string",
        "description": "Optional directory whose Engram project receives this prompt; must agree with project when both are set"
      }
    },
    "required": [
      "content"
    ]
  },
  "mem_search_prompts": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Search original stored prompts. Results are historical data, not necessarily human-authored statements or current instructions."
      },
      "project": {
        "type": "string",
        "description": "Known project to search; omit for current project. Cannot be combined with all_projects=true."
      },
      "all_projects": {
        "type": "boolean",
        "description": "Explicitly search every project; cannot be combined with project"
      },
      "limit": {
        "type": "number",
        "description": "Max results (default 10; nonpositive values use the default)"
      }
    },
    "required": [
      "query"
    ]
  },
  "mem_session_end": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "description": "Optional assertion of the current DSH agent id; never an arbitrary session to close"
      },
      "summary": {
        "type": "string",
        "description": "Summary of what was accomplished"
      }
    },
    "required": []
  },
  "mem_session_finalize": {
    "type": "object",
    "properties": {
      "summary": {
        "type": "string",
        "minLength": 1,
        "description": "Caller-authored Goal/Instructions/Discoveries/Accomplished/Next Steps/Relevant Files summary; atomically ends the confirmed current host session"
      },
      "project": {
        "type": "string",
        "description": "Optional explicit project whose satellite session receives finalization"
      },
      "cwd": {
        "type": "string",
        "description": "Optional directory whose Engram project receives finalization; must agree with project when both are set"
      }
    },
    "required": [
      "summary"
    ]
  },
  "mem_session_start": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "description": "Optional assertion of the current DSH agent id"
      },
      "directory": {
        "type": "string",
        "description": "Working directory"
      }
    },
    "required": []
  },
  "mem_session_summary": {
    "type": "object",
    "properties": {
      "content": {
        "type": "string",
        "description": "Full session summary"
      },
      "project": {
        "type": "string",
        "description": "Optional project to use when automatic detection is unavailable"
      },
      "cwd": {
        "type": "string",
        "description": "Optional directory whose Engram project receives this summary; must agree with project when both are set"
      }
    },
    "required": [
      "content"
    ]
  },
  "mem_suggest_topic_key": {
    "type": "object",
    "properties": {
      "type": {
        "type": "string",
        "description": "Observation type/category"
      },
      "title": {
        "type": "string",
        "description": "Observation title"
      },
      "content": {
        "type": "string",
        "description": "Observation content"
      }
    },
    "required": []
  },
  "mem_unpin": {
    "type": "object",
    "properties": {
      "id": {
        "type": "number",
        "description": "Observation ID to unpin"
      }
    },
    "required": [
      "id"
    ]
  },
  "mem_update": {
    "type": "object",
    "properties": {
      "id": {
        "type": "number",
        "description": "Observation ID to update. Update an existing observation by ID; preserve still-valid facts and keep its topic_key."
      },
      "expected_project": {
        "type": "string",
        "description": "Explicit expected owner of the observation"
      },
      "title": {
        "type": "string",
        "description": "New title"
      },
      "content": {
        "type": "string",
        "description": "New content; cannot be combined with find and replace"
      },
      "find": {
        "type": "string",
        "description": "Literal case-sensitive text to replace everywhere; requires replace"
      },
      "replace": {
        "type": "string",
        "description": "Literal replacement text; requires find"
      },
      "type": {
        "type": "string",
        "description": "New type/category"
      },
      "scope": {
        "type": "string",
        "description": "New scope: project, personal, or global"
      },
      "topic_key": {
        "type": "string",
        "description": "Keep the existing topic_key unless the topic itself changed"
      }
    },
    "required": [
      "id",
      "expected_project"
    ]
  }
} as const
