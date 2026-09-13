/** Hide unrelated outputs without deleting graph inputs. A clip's source can
 * live on its own track, another track, or an otherwise unused card node. */
export function isolateClip(project, clipId, { preserveContext = false } = {}) {
  const targetIndex = (project.tracks || []).findIndex(track => (track.clips || []).some(clip => clip.id === clipId));
  if (targetIndex < 0) return null;
  const targetTrack = project.tracks[targetIndex];
  const clipIndex = targetTrack.clips.findIndex(clip => clip.id === clipId);
  const clip = targetTrack.clips[clipIndex];
  const node = (project.cardNodes || []).find(node => node.id === clip.nodeId);
  const definition = (project.cardDefinitions || []).find(def => def.id === node?.definitionId);
  // Unknown Chrome composition must keep its lower browser scene. Explicitly
  // independent Python cards still resolve hidden inputs through sourceProject.
  const context = preserveContext && (node ? definition?.compositing !== 'independent' : !!clip.cardId);
  const ids = new Set(project.tracks.map(track => track.id));
  const tracks = project.tracks.flatMap((track, index) => {
    if (index !== targetIndex) return [{ ...track, ...(context && index > targetIndex ? {} : { hidden: true, sourceOnly: true }) }];
    const visible = context ? track.clips.slice(0, clipIndex + 1) : [clip];
    const siblings = track.clips.filter(item => !visible.includes(item));
    const result = [{ ...track, hidden: false, sourceOnly: false, clips: visible }];
    if (siblings.length) {
      let id = `__pc_vision_source_${track.id}`, suffix = 1;
      while (ids.has(id)) id = `__pc_vision_source_${track.id}_${suffix++}`;
      ids.add(id);
      result.push({ ...track, id, hidden: true, sourceOnly: true, clips: siblings });
    }
    return result;
  });
  return { clip, context, project: { ...project, tracks } };
}
