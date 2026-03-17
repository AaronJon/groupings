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

    // Disable button to prevent double submit
    const submitBtn = form.querySelector("button[type='submit']");
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting...";

    const student = {
      first:  first.value.trim(),
      middle: middle.value.trim(),
      last:   last.value.trim(),
      index:  index.value.trim(),
      region: region.value,
      joinedAt: new Date().toISOString(),
    };

    // CHECK IF INDEX ALREADY HAS A GROUP
    // If index exists in students BUT has no group → allow them through (orphan)
    // If index exists in students AND has a group → block as duplicate
    try {
      const dupSnapshot = await db.collection("students")
        .where("index", "==", student.index)
        .get();

      if (!dupSnapshot.empty) {
        // Check if this student is actually in any group
        const groupsSnap = await db.collection("groups").get();
        let isInGroup = false;

        groupsSnap.forEach((doc) => {
          const members = doc.data().members || [];
          if (members.find((m) => m.index === student.index)) {
            isInGroup = true;
          }
        });

        if (isInGroup) {
          // Truly already registered and has a group — block them
          document.getElementById("indexError").textContent =
            "This index number has already been used.";
          submitBtn.disabled = false;
          submitBtn.textContent = "Join Group";
          return;
        } else {
          // Orphan — they registered but lost their group
          // Delete their old students record so they get a clean entry
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
// Priority:
// 1. Find open same-region group → join it
// 2. No same-region group available → create a new group
// 3. arrayUnion used for safe atomic writes
// =======================
async function assignGroup(student) {
  try {
    const groupsRef = db.collection("groups");

    // Always fetch fresh live data
    const freshSnap = await groupsRef.get();
    let groups = [];
    freshSnap.forEach((doc) => {
      groups.push({ id: doc.id, ref: doc.ref, ...doc.data() });
    });

    // Sort by groupNumber — fill earlier groups first
    groups.sort((a, b) => (a.groupNumber || 0) - (b.groupNumber || 0));

    let assignedGroup = null;

    // 1. Find open same-region group
    for (let group of groups) {
      const count = (group.members || []).length;
      if (!group.locked && count < 10 && group.region === student.region) {
        assignedGroup = group;
        break;
      }
    }

    // 2. No same-region group → create a new one
    if (!assignedGroup) {
      // Use max existing groupNumber to avoid duplicates
      const maxNumber = groups.reduce((max, g) => Math.max(max, g.groupNumber || 0), 0);
      const groupNumber = maxNumber + 1;
      const newGroupRef = groupsRef.doc("Group-" + groupNumber);

      await newGroupRef.set({
        groupNumber: groupNumber,
        label:       "Group " + groupNumber,
        region:      student.region,
        members:     [],
        locked:      false,
      });

      assignedGroup = {
        id:          "Group-" + groupNumber,
        ref:         newGroupRef,
        groupNumber: groupNumber,
        label:       "Group " + groupNumber,
        region:      student.region,
        members:     [],
      };
    }

    // 3. Add student atomically with arrayUnion — prevents overwrites
    const groupRef = assignedGroup.ref || groupsRef.doc(assignedGroup.id);
    await groupRef.update({
      members: firebase.firestore.FieldValue.arrayUnion(student),
    });

    // 4. Check live count and lock if full
    const updatedDoc   = await groupRef.get();
    const updatedCount = updatedDoc.data().members.length;
    if (updatedCount >= 10) {
      await groupRef.update({ locked: true });
    }

    // 5. Save to students collection only after group write succeeded
    await db.collection("students").add(student);

    // 6. Show success
    showSuccess(assignedGroup.label);

  } catch (err) {
    console.error("Error assigning group:", err);
    alert("Something went wrong. Please try again.");
  }
}

// =======================
// SUCCESS POPUP
// =======================
function showSuccess(groupLabel) {
  document.getElementById("groupMessage").textContent =
    "You have been placed in " + groupLabel + "! 🎉";

  // Close join modal first
  const joinModalEl = document.getElementById("joinModal");
  if (joinModalEl) {
    const joinModal = bootstrap.Modal.getInstance(joinModalEl);
    if (joinModal) joinModal.hide();
  }

  setTimeout(() => {
    const successModal = new bootstrap.Modal(document.getElementById("successModal"));
    successModal.show();

    // If on groups page, reload cards when success modal is dismissed
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
    const groupDocs = [];
    groupsSnap.forEach((doc) => groupDocs.push({ id: doc.id, ...doc.data(), _ref: doc }));
    groupDocs.sort((a, b) => (a.groupNumber || 0) - (b.groupNumber || 0));

    if (groupDocs.length === 0) {
      container.innerHTML = `<div class="text-center w-100 py-5 text-muted">No groups yet. Be the first to join!</div>`;
      return;
    }

    container.innerHTML = "";

    groupDocs.forEach((group) => {
      const count = group.members ? group.members.length : 0;
      const label = group.label || group.id;
      const isLocked = count >= 10;
      const fillPercent = (count / 10) * 100;
      const barColor = isLocked ? "#e63946" : count >= 7 ? "#f4a261" : "#4facfe";

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
async function viewGroup(groupId, groupLabel) {
  try {
    const doc = await db.collection("groups").doc(groupId).get();
    const group = doc.data();
    const members = group.members || [];

    // Set modal title
    document.getElementById("modalGroupTitle").textContent = groupLabel || groupId;
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
    result.innerHTML = "Please enter a name to search.";
    result.className = "text-warning fw-bold";
    return;
  }

  result.innerHTML = "Searching...";
  result.className = "text-muted fw-bold";

  try {
    const groupsSnap = await db.collection("groups").get();
    const matches = [];

    groupsSnap.forEach((doc) => {
      const group = doc.data();
      const label = group.label || doc.id;
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

    // Build result lines for all matches
    result.className = "text-success fw-bold";
    result.innerHTML = matches.map(({ m, label }) => {
      const fullName = `${m.first} ${m.middle ? m.middle + " " : ""}${m.last}`;
      return `${fullName} (${m.index}) — ${label}`;
    }).join("<br>");

  } catch (err) {
    console.error("Error searching:", err);
    result.textContent = "Search failed. Please try again.";
    result.className = "text-danger fw-bold";
  }
}
