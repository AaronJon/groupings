// =======================
// FORM SUBMISSION
// =======================
const form = document.getElementById("studentForm");

if (form) {
  form.addEventListener("submit", async function (e) {
    e.preventDefault();

    const first  = document.getElementById("firstName");
    const middle = document.getElementById("middleName");
    const last   = document.getElementById("lastName");
    const index  = document.getElementById("indexNumber");
    const region = document.getElementById("region");

    // Clear previous errors
    document.getElementById("firstNameError").textContent = "";
    document.getElementById("lastNameError").textContent  = "";
    document.getElementById("indexError").textContent     = "";

    // VALIDATION
    let valid = true;

    if (first.value.trim() === "") {
      document.getElementById("firstNameError").textContent = "First name is required";
      valid = false;
    }

    if (last.value.trim() === "") {
      document.getElementById("lastNameError").textContent = "Last name is required";
      valid = false;
    }

    if (index.value.trim() === "") {
      document.getElementById("indexError").textContent = "Index number is required";
      valid = false;
    } else if (index.value.includes(" ")) {
      document.getElementById("indexError").textContent = "Index number cannot contain spaces";
      valid = false;
    }

    if (!valid) return;

    const submitBtn = form.querySelector("button[type='submit']");
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting...";

    const student = {
      first:    first.value.trim(),
      middle:   middle.value.trim(),
      last:     last.value.trim(),
      index:    index.value.trim(),
      region:   region.value,
      joinedAt: new Date().toISOString(),
    };

    try {
      // Check if index exists in students collection
      const dupSnapshot = await db.collection("students")
        .where("index", "==", student.index)
        .get();

      if (!dupSnapshot.empty) {
        // Index found — check if they actually have a group
        const groupsSnap = await db.collection("groups").get();
        let isInGroup = false;

        groupsSnap.forEach((doc) => {
          const members = doc.data().members || [];
          if (members.find((m) => m.index === student.index)) {
            isInGroup = true;
          }
        });

        if (isInGroup) {
          // Has a group — genuine duplicate, block them
          document.getElementById("indexError").textContent =
            "This index number has already been used.";
          submitBtn.disabled = false;
          submitBtn.textContent = "Join Group";
          return;
        } else {
          // Orphan — in students but no group, clean up and let them through
          for (const doc of dupSnapshot.docs) {
            await doc.ref.delete();
          }
        }
      }

      await assignGroup(student);

    } catch (err) {
      console.error("Error submitting:", err);
      submitBtn.disabled = false;
      submitBtn.textContent = "Join Group";
      return;
    }

    submitBtn.disabled = false;
    submitBtn.textContent = "Join Group";
  });
}

// =======================
// GROUP ASSIGNMENT
// Transaction locks the exact target group doc during read+write
// so no two students can write to it at the same time
// If group fills up between check and write → auto retry
// =======================
async function assignGroup(student) {
  try {
    const groupsRef = db.collection("groups");

    // Fetch all groups fresh
    const freshSnap = await groupsRef.get();
    let groups = [];
    freshSnap.forEach((doc) => {
      const data = doc.data();
      groups.push({
        id:          doc.id,
        ref:         doc.ref,
        groupNumber: parseInt(data.groupNumber) || 0,
        label:       data.label || doc.id,
        region:      (data.region || "").trim(),
        members:     data.members || [],
        locked:      data.locked || false,
      });
    });
    groups.sort((a, b) => a.groupNumber - b.groupNumber);

    // Find open same-region group
    let targetGroup = null;
    const studentRegion = (student.region || "").trim();
    for (let group of groups) {
      const count = group.members.length;
      if (count < 10 && group.region === studentRegion) {
        targetGroup = group;
        break;
      }
    }

    // No same-region group → create a new one
    if (!targetGroup) {
      const maxNumber   = groups.reduce((max, g) => Math.max(max, g.groupNumber || 0), 0);
      const groupNumber = maxNumber + 1;
      const newGroupRef = groupsRef.doc("Group-" + groupNumber);

      await newGroupRef.set({
        groupNumber: groupNumber,
        label:       "Group " + groupNumber,
        region:      studentRegion,
        members:     [],
        locked:      false,
      });

      targetGroup = {
        id:          "Group-" + groupNumber,
        ref:         newGroupRef,
        groupNumber: groupNumber,
        label:       "Group " + groupNumber,
        region:      studentRegion,
        members:     [],
      };
    }

    const groupRef    = targetGroup.ref || groupsRef.doc(targetGroup.id);
    const groupLabel  = targetGroup.label;

    // Transaction locks this specific group doc
    // reads the TRUE live member count
    // writes only if still has space
    // if full → throws GROUP_FULL → retry entire function
    await db.runTransaction(async (transaction) => {
      const groupDoc       = await transaction.get(groupRef);
      const currentMembers = groupDoc.data().members || [];

      if (currentMembers.length >= 10) {
        throw new Error("GROUP_FULL");
      }

      const newMembers = [...currentMembers, student];
      const isNowFull  = newMembers.length >= 10;

      // Write group update
      transaction.update(groupRef, {
        members: newMembers,
        locked:  isNowFull,
      });

      // Write student record in same transaction
      // Either BOTH succeed or BOTH fail — no orphans possible
      const newStudentRef = db.collection("students").doc();
      transaction.set(newStudentRef, student);
    });

    showSuccess(groupLabel);

  } catch (err) {
    if (err.message === "GROUP_FULL") {
      // Group filled between our check and transaction write
      // Retry — this time that group will be skipped as full
      console.log("Group was full, retrying assignment...");
      await assignGroup(student);
    } else {
      console.error("Error assigning group:", err);
      alert("Something went wrong. Please try again.");
    }
  }
}

// =======================
// SUCCESS POPUP
// =======================
function showSuccess(groupLabel) {
  document.getElementById("groupMessage").textContent =
    "You have been placed in " + groupLabel + "! 🎉";

  const joinModalEl = document.getElementById("joinModal");
  if (joinModalEl) {
    const joinModal = bootstrap.Modal.getInstance(joinModalEl);
    if (joinModal) joinModal.hide();
  }

  setTimeout(() => {
    const successModal = new bootstrap.Modal(document.getElementById("successModal"));
    successModal.show();

    const successModalEl = document.getElementById("successModal");
    successModalEl.addEventListener("hidden.bs.modal", function onHide() {
      successModalEl.removeEventListener("hidden.bs.modal", onHide);
      if (document.getElementById("groupsContainer")) loadGroups();
    });
  }, 400);
}

function goToGroups() {
  window.location.href = "groups.html";
}

// =======================
// LOAD GROUP CARDS (groups.html)
// =======================
async function loadGroups() {
  const container = document.getElementById("groupsContainer");
  if (!container) return;

  container.innerHTML = `<div class="text-center w-100 py-5 text-muted">Loading groups...</div>`;

  try {
    const groupsSnap = await db.collection("groups").get();
    const groupDocs  = [];
    groupsSnap.forEach((doc) => groupDocs.push({ id: doc.id, ...doc.data() }));
    groupDocs.sort((a, b) => (a.groupNumber || 0) - (b.groupNumber || 0));

    if (groupDocs.length === 0) {
      container.innerHTML = `<div class="text-center w-100 py-5 text-muted">No groups yet. Be the first to join!</div>`;
      return;
    }

    container.innerHTML = "";

    groupDocs.forEach((group) => {
      const count      = group.members ? group.members.length : 0;
      const label      = group.label || group.id;
      const isLocked   = count >= 10;
      const fillPercent = (count / 10) * 100;
      const barColor   = isLocked ? "#e63946" : count >= 7 ? "#f4a261" : "#4facfe";

      const col = document.createElement("div");
      col.className = "col-sm-6 col-md-4 col-lg-3";
      col.innerHTML = `
        <div class="groupCard card h-100">
          <div class="card-body d-flex flex-column align-items-center text-center p-4">
            <div class="group-icon mb-2">👥</div>
            <h5 class="fw-bold mb-1">${label}</h5>
            <span class="badge mb-3 ${isLocked ? "bg-danger" : "bg-primary"}">
              ${isLocked ? "Full" : "Open"}
            </span>
            <p class="mb-1 text-muted small">${count} / 10 members</p>
            <div class="progress w-100 mb-3" style="height:6px; border-radius:10px;">
              <div class="progress-bar" style="width:${fillPercent}%; background:${barColor}; border-radius:10px;"></div>
            </div>
            <button class="btn btn-sm btn-outline-primary mt-auto w-100"
              onclick="viewGroup('${group.id}', '${label}')">
              View Members
            </button>
          </div>
        </div>
      `;
      container.appendChild(col);
    });

  } catch (err) {
    console.error("Error loading groups:", err);
    container.innerHTML = `<div class="text-center text-danger w-100">Failed to load groups. Please refresh.</div>`;
  }
}

loadGroups();

// =======================
// VIEW MEMBERS MODAL
// =======================
async function viewGroup(groupId, groupLabel) {
  try {
    const doc     = await db.collection("groups").doc(groupId).get();
    const group   = doc.data();
    const members = group.members || [];

    document.getElementById("modalGroupTitle").textContent  = groupLabel || groupId;
    document.getElementById("modalMemberCount").textContent = members.length + " / 10 members";

    const list = document.getElementById("memberList");
    list.innerHTML = "";

    if (members.length === 0) {
      list.innerHTML = `<li class="list-group-item text-muted text-center">No members yet</li>`;
    } else {
      members.forEach((m, i) => {
        const li = document.createElement("li");
        li.className = "list-group-item d-flex align-items-center gap-3 py-3";
        li.innerHTML = `
          <div class="member-avatar">${m.first.charAt(0)}${m.last.charAt(0)}</div>
          <div class="flex-grow-1">
            <div class="fw-semibold">${m.first} ${m.middle ? m.middle + " " : ""}${m.last}</div>
            <div class="text-muted small">${m.index} &nbsp;•&nbsp; ${m.region}</div>
          </div>
          <span class="badge bg-light text-secondary border">#${i + 1}</span>
        `;
        list.appendChild(li);
      });
    }

    const modal = new bootstrap.Modal(document.getElementById("groupModal"));
    modal.show();

  } catch (err) {
    console.error("Error viewing group:", err);
  }
}

// =======================
// SEARCH BY NAME (partial match)
// =======================
async function searchStudent() {
  const query  = document.getElementById("searchIndex").value.trim().toLowerCase();
  const result = document.getElementById("searchResult");

  if (!query) {
    result.innerHTML  = "Please enter a name to search.";
    result.className  = "text-warning fw-bold";
    return;
  }

  result.innerHTML = "Searching...";
  result.className = "text-muted fw-bold";

  try {
    const groupsSnap = await db.collection("groups").get();
    const matches    = [];

    groupsSnap.forEach((doc) => {
      const group   = doc.data();
      const label   = group.label || doc.id;
      const members = group.members || [];

      members.forEach((m) => {
        const fullName = `${m.first} ${m.middle ? m.middle + " " : ""}${m.last}`.toLowerCase();
        if (fullName.includes(query)) {
          matches.push({ m, label });
        }
      });
    });

    if (matches.length === 0) {
      result.innerHTML = `No student found matching "<strong>${query}</strong>".`;
      result.className = "text-danger fw-bold";
      return;
    }

    result.className = "text-success fw-bold";
    result.innerHTML = matches.map(({ m, label }) => {
      const fullName = `${m.first} ${m.middle ? m.middle + " " : ""}${m.last}`;
      return `${fullName} (${m.index}) — ${label}`;
    }).join("<br>");

  } catch (err) {
    console.error("Error searching:", err);
    result.textContent = "Search failed. Please try again.";
    result.className   = "text-danger fw-bold";
  }
}
